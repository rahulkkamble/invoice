// src/App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Invoice Record — Builder (ABDM/FHIR document bundle)
  - Patient: fetched from /patients.json (public)
  - Practitioner: from window.GlobalPractitioner (FHIR Practitioner) or safe fallback
  - ABHA addresses normalized and selectable
  - Invoice resource with line items, quantities, unit price (INR), auto total
  - Optional Encounter, Custodian, Attester
  - Optional DocumentReference + Binary (PDF/JPG/JPEG uploads; placeholder PDF if none)
  - Composition.type.text fixed: "Invoice Record" (per profile)
  - Bundle.type: "document"; internal references via urn:uuid:<uuid>
  - All narratives include lang & xml:lang (validator-friendly)
*/

/* ------------------------------- UTILITIES --------------------------------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
}
function safeUuid(maybeId) {
  return isUuid((maybeId || "").toLowerCase()) ? maybeId.toLowerCase() : uuidv4();
}

function ddmmyyyyToISO(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const sep = s.includes("-") ? "-" : s.includes("/") ? "/" : null;
  if (!sep) return undefined;
  const parts = s.split(sep);
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return undefined;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/* ISO datetime with local timezone offset (e.g., 2025-08-30T15:04:05+05:30) */
function isoWithLocalOffsetFromDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const pad = n => String(Math.abs(Math.floor(n))).padStart(2, "0");
  const tzo = -date.getTimezoneOffset();
  const sign = tzo >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tzo) / 60));
  const mm = pad(Math.abs(tzo) % 60);
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes()) +
    ":" +
    pad(date.getSeconds()) +
    sign +
    hh +
    ":" +
    mm
  );
}

/* Convert 'datetime-local' input (YYYY-MM-DDTHH:MM) to iso-with-offset */
function localDatetimeToISOWithOffset(localDatetime) {
  if (!localDatetime) return isoWithLocalOffsetFromDate(new Date());
  return isoWithLocalOffsetFromDate(new Date(localDatetime));
}

/* XHTML narrative wrapper with lang/xml:lang */
function buildNarrative(title, innerHtml) {
  return {
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><h3>${title}</h3>${innerHtml}</div>`,
  };
}

/* Read file -> base64 (strip data: prefix) */
function fileToBase64NoPrefix(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read error"));
    reader.onload = () => {
      const res = reader.result || "";
      const idx = String(res).indexOf("base64,");
      if (idx >= 0) resolve(String(res).slice(idx + 7));
      else resolve(String(res));
    };
    reader.readAsDataURL(file);
  });
}

/* tiny placeholder PDF header */
const PLACEHOLDER_PDF_B64 = "JVBERi0xLjQKJeLjz9MK";

/* Normalize ABHA addresses (strings or objects) */
function normalizeAbhaAddresses(patientObj) {
  const raw =
    patientObj?.additional_attributes?.abha_addresses && Array.isArray(patientObj.additional_attributes.abha_addresses)
      ? patientObj.additional_attributes.abha_addresses
      : Array.isArray(patientObj?.abha_addresses)
        ? patientObj.abha_addresses
        : [];

  const out = raw
    .map(item => {
      if (!item) return null;
      if (typeof item === "string") return { value: item, label: item, primary: false };
      if (typeof item === "object") {
        if (item.address) return { value: String(item.address), label: item.isPrimary ? `${item.address} (primary)` : String(item.address), primary: !!item.isPrimary };
        try {
          const v = JSON.stringify(item);
          return { value: v, label: v, primary: !!item.isPrimary };
        } catch { return null; }
      }
      return null;
    })
    .filter(Boolean);
  out.sort((a, b) => (b.primary - a.primary) || a.value.localeCompare(b.value));
  return out;
}

/* Practitioner globals (from window) */
const gp = typeof window !== "undefined" ? window.GlobalPractitioner : null;
const practitionerRefId = safeUuid(gp?.id);
const practitionerDisplayName =
  (Array.isArray(gp?.name) && gp.name?.[0]?.text) ||
  (typeof gp?.name === "string" ? gp.name : "") ||
  "Dr. ABC";
const practitionerLicense =
  (Array.isArray(gp?.identifier) && gp.identifier?.[0]?.value) ||
  gp?.license ||
  "LIC-TEMP-0001";

/* ------------------------------- APP -------------------------------------- */
export default function App() {
  /* Patient selection */
  const [patients, setPatients] = useState([]);
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);
  const selectedPatient = useMemo(() => (selectedPatientIdx >= 0 ? patients[selectedPatientIdx] : null), [patients, selectedPatientIdx]);

  /* ABHA selection */
  const [abhaOptions, setAbhaOptions] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");

  /* Composition meta */
  const [status, setStatus] = useState("final");
  const [title, setTitle] = useState("Invoice Record");
  const [dateTimeLocal, setDateTimeLocal] = useState(() => {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  /* Optional metadata */
  const [encounterText, setEncounterText] = useState("");
  const [custodianName, setCustodianName] = useState("");
  const [attesterMode, setAttesterMode] = useState("professional"); // personal | professional | legal | official
  const [attesterPartyType, setAttesterPartyType] = useState("Practitioner"); // Practitioner | Organization
  const [attesterOrgName, setAttesterOrgName] = useState("");

  /* Invoice lines */
  const [lines, setLines] = useState([
    { description: "Consultation", quantity: 1, unitPrice: 500 },
  ]);

  function addLine() {
    setLines(prev => [...prev, { description: "", quantity: 1, unitPrice: 0 }]);
  }
  function updateLine(i, key, val) {
    setLines(prev => prev.map((m, idx) => (idx === i ? { ...m, [key]: val } : m)));
  }
  function removeLine(i) {
    setLines(prev => prev.filter((_, idx) => idx !== i));
  }
  const invoiceTotal = useMemo(
    () => lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0),
    [lines]
  );

  /* Document uploads (optional) */
  const fileInputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [filePreviewNames, setFilePreviewNames] = useState([]);

  function onFilesPicked(e) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
    setFilePreviewNames(list.map(f => f.name));
  }
  function removeFileAtIndex(i) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setFilePreviewNames(prev => prev.filter((_, idx) => idx !== i));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /* Load patients */
  /* ---------- Fetch patients: try API first, fallback to local ---------- */
  useEffect(() => {
    (async () => {
      try {
        // 🔹 First try API endpoint
        const apiRes = await fetch(window.GlobalPatientAPI, {
          headers: {
            "Content-Type": "application/json",
            ...(window.GlobalAuthToken ? { "Authorization": `Bearer ${window.GlobalAuthToken}` } : {})
          }
        });
        if (!apiRes.ok) throw new Error("API fetch failed");
        const apiData = await apiRes.json();
        if (!Array.isArray(apiData) || apiData.length === 0) throw new Error("API returned empty");

        // If API worked, use it
        setPatients(apiData);
        setSelectedPatientIdx(0);

        const p = apiData[0];
        const abhas = normalizeAbhaAddresses(p);
        setAbhaOptions(abhas);
        setSelectedAbha(abhas.length ? abhas[0].value : "");
      } catch (apiErr) {
        console.warn("⚠️ Patient not found in API. Fetching from local patients.json instead.");
        console.warn("API fetch failed, falling back to local patients.json", apiErr);
        try {
          const localRes = await fetch("/patients.json");
          const localData = await localRes.json();
          const arr = Array.isArray(localData) ? localData : [];
          setPatients(arr);
          if (arr.length > 0) {
            setSelectedPatientIdx(0);
            const p = arr[0];
            const abhas = normalizeAbhaAddresses(p);
            setAbhaOptions(abhas);
            setSelectedAbha(abhas.length ? abhas[0].value : "");
          }
        } catch (localErr) {
          console.error("Failed to fetch local patients.json:", localErr);
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedPatient) {
      setAbhaOptions([]);
      setSelectedAbha("");
      return;
    }
    const abhas = normalizeAbhaAddresses(selectedPatient);
    setAbhaOptions(abhas);
    setSelectedAbha(abhas.length ? abhas[0].value : "");
  }, [selectedPatientIdx]); // eslint-disable-line

  /* Validation */
  function validateBeforeBuild() {
    const errors = [];
    if (!selectedPatient) errors.push("Select a patient (required).");
    if (!status) errors.push("Status is required.");
    if (!title || !title.trim()) errors.push("Title is required.");
    // Require at least one invoice line with amount > 0 OR at least one document
    const hasCharge = lines.some(l => (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0) > 0);
    const hasDocs = files && files.length > 0;
    if (!(hasCharge || hasDocs)) errors.push("Add at least one invoice line with amount > 0, or upload at least one document.");
    return errors;
  }

  /* ---------------------- Build FHIR Bundle (async) ------------------------ */
  async function onBuildBundle() {
    const errors = validateBeforeBuild();
    if (errors.length) {
      alert("Please fix:\n" + errors.join("\n"));
      return;
    }

    const authoredOn = localDatetimeToISOWithOffset(dateTimeLocal);

    // UUID ids for urn:uuid references
    const compId = uuidv4();
    const patientId = uuidv4(); // bundle-local Patient.id
    const practitionerId = practitionerRefId || uuidv4();
    const encounterId = encounterText ? uuidv4() : null;
    const custodianId = custodianName ? uuidv4() : null;
    const attesterOrgId = attesterPartyType === "Organization" && attesterOrgName ? uuidv4() : null;

    const invoiceId = uuidv4();
    const docBinaryIds = (files.length ? files : [null]).map(() => uuidv4());
    const docRefIds = docBinaryIds.map(() => uuidv4());

    // Patient resource
    function buildPatientResource(idForBundle) {
      const p = selectedPatient || {};
      const identifiers = [];
      const mrnLocal = p?.user_ref_id || p?.mrn || p?.abha_ref || p?.id;
      if (mrnLocal) identifiers.push({ system: "https://healthid.ndhm.gov.in", value: String(mrnLocal) });
      if (p?.abha_ref) identifiers.push({ system: "https://abdm.gov.in/abha", value: p.abha_ref });

      const telecom = [];
      if (p?.mobile) telecom.push({ system: "phone", value: p.mobile });
      if (p?.email) telecom.push({ system: "email", value: p.email });
      if (selectedAbha) telecom.push({ system: "url", value: `abha://${selectedAbha}` });

      return {
        resourceType: "Patient",
        id: idForBundle,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Patient"] },
        // text: buildNarrative("Patient", `<p>${p.name || ""}</p><p>${p.gender || ""} ${p.dob || ""}</p>`),
        identifier: identifiers.length ? identifiers : undefined,
        name: p.name ? [{ text: p.name }] : undefined,
        gender: p.gender ? String(p.gender).toLowerCase() : undefined,
        birthDate: ddmmyyyyToISO(p.dob) || undefined,
        telecom: telecom.length ? telecom : undefined,
        address: p?.address ? [{ text: p.address }] : undefined,
      };
    }

    // Practitioner resource
    function buildPractitionerResource(practRefId, practName, practLicense) {
      return {
        resourceType: "Practitioner",
        id: practRefId,
        language: "en-IN",
        meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner"] },
        // text: buildNarrative("Practitioner", `<p>${practName}</p>`),
        identifier: [{
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MD", display: "Medical License number" }] },
          system: "https://doctor.ndhm.gov.in",
          value: practLicense
        }],
        name: [{ text: practName }],
      };
    }

    // Encounter (optional)
    function buildEncounterResource() {
      if (!encounterId) return null;
      const start = isoWithLocalOffsetFromDate(new Date());
      return {
        resourceType: "Encounter",
        id: encounterId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
        // text: buildNarrative("Encounter", `<p>${encounterText}</p>`),
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
        subject: { reference: `urn:uuid:${patientId}` },
        period: { start, end: start },
      };
    }

    // Custodian Organization (optional)
    function buildCustodianOrg() {
      if (!custodianId) return null;
      return {
        resourceType: "Organization",
        id: custodianId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        // text: buildNarrative("Organization", `<p>${custodianName}</p>`),
        name: custodianName,
      };
    }

    // Attester org (optional)
    function buildAttesterOrg() {
      if (!attesterOrgId) return null;
      return {
        resourceType: "Organization",
        id: attesterOrgId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        // text: buildNarrative("Organization", `<p>${attesterOrgName}</p>`),
        name: attesterOrgName,
      };
    }

    // Invoice resource (FHIR R4)
    function buildInvoiceResource() {
      // Map line items to Invoice.lineItem with priceComponent
      const lineItems = lines
        .filter(l => (Number(l.quantity) || 0) > 0 && (Number(l.unitPrice) || 0) >= 0)
        .map(l => {
          const qty = Number(l.quantity) || 0;
          const unit = Number(l.unitPrice) || 0;
          const amount = qty * unit;
          return {
            sequence: undefined,
            chargeItemCodeableConcept: { text: l.description || "Charge" },
            priceComponent: [
              {
                type: "base",
                amount: { value: unit, currency: "INR" }
              },
              {
                type: "informational",
                code: { text: "quantity" },
                factor: qty
              }
            ]
          };
        });

      return {
        resourceType: "Invoice",
        id: invoiceId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Invoice"] },
        // text: buildNarrative("Invoice", `<p>Total: ₹${Number(invoiceTotal).toFixed(2)}</p>`),
        status: "issued", // draft | issued | balanced | cancelled | entered-in-error
        type: { text: "Healthcare invoice" },
        subject: { reference: `urn:uuid:${patientId}` },
        date: authoredOn,
        participant: [{ role: { text: "issuer" }, actor: { reference: `urn:uuid:${practitionerId}`, display: practitionerDisplayName } }],
        lineItem: lineItems.length ? lineItems : undefined,
        totalNet: { value: Number(invoiceTotal.toFixed(2)), currency: "INR" },
        totalGross: { value: Number(invoiceTotal.toFixed(2)), currency: "INR" },
      };
    }

    // DocumentReference + Binary (optional or placeholder)
    async function buildDocAndBinaryResources() {
      const binaries = [];
      const docRefs = [];

      const toProcess = files.length > 0 ? files : [null]; // null => placeholder
      for (let i = 0; i < toProcess.length; i++) {
        const f = toProcess[i];
        const binId = docBinaryIds[i];
        const docId = docRefIds[i];

        let contentType = "application/pdf";
        let dataB64 = PLACEHOLDER_PDF_B64;
        let titleDoc = "placeholder.pdf";

        if (f) {
          contentType = f.type || "application/pdf";
          dataB64 = await fileToBase64NoPrefix(f);
          titleDoc = f.name || titleDoc;
        }

        const binary = {
          resourceType: "Binary",
          id: binId,
          language: "en-IN",
          meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Binary"] },
          contentType,
          data: dataB64,
        };

        const docRef = {
          resourceType: "DocumentReference",
          id: docId,
          language: "en-IN",
          meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DocumentReference"] },
          // text: buildNarrative("DocumentReference", `<p>${titleDoc}</p>`),
          status: "current",
          type: { text: "Invoice document" },
          subject: { reference: `urn:uuid:${patientId}` },
          date: authoredOn,
          content: [{ attachment: { contentType, title: titleDoc, url: `urn:uuid:${binId}` } }],
        };

        binaries.push(binary);
        docRefs.push(docRef);
      }

      return { binaries, docRefs };
    }

    // Composition (Invoice Record)
    function buildComposition(docRefsArr) {
      const entries = [];
      // Include Invoice first
      entries.push({ reference: `urn:uuid:${invoiceId}`, type: "Invoice" });
      // Include uploaded documents
      if (docRefsArr && docRefsArr.length) docRefsArr.forEach(dr => entries.push({ reference: `urn:uuid:${dr.id}`, type: "DocumentReference" }));

      const attesterArr = [];
      if (attesterPartyType === "Practitioner") {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${practitionerId}` } });
      } else if (attesterPartyType === "Organization" && attesterOrgId) {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${attesterOrgId}` } });
      }

      const comp = {
        resourceType: "Composition",
        id: compId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
        // text: buildNarrative("Composition", `<p>${title}</p><p>Author: ${practitionerDisplayName}</p>`),
        status: status,
        type: {
          // Profile fixes type.text = "Invoice Record"
          text: "Invoice Record"
        },
        subject: { reference: `urn:uuid:${patientId}` },
        ...(encounterId ? { encounter: { reference: `urn:uuid:${encounterId}` } } : {}),
        date: authoredOn,
        author: [{ reference: `urn:uuid:${practitionerId}`, display: practitionerDisplayName }],
        title: title,
        attester: (attesterArr.length ? attesterArr : [{ mode: "official", party: { reference: `urn:uuid:${practitionerId}` } }]),
        ...(custodianId ? { custodian: { reference: `urn:uuid:${custodianId}` } } : {}),
        section: [
          {
            title: "Invoice section",
            code: { text: "Invoice Record" },
            entry: entries.length ? entries : undefined,
            text: entries.length ? undefined : {
              status: "generated",
              div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><p>No invoice entries</p></div>`,
            },
          },
        ],
      };
      return comp;
    }

    // Build resources
    const patientRes = buildPatientResource(patientId);
    const practitionerRes = buildPractitionerResource(practitionerId, practitionerDisplayName, practitionerLicense);
    const encounterRes = buildEncounterResource();
    const custodianRes = buildCustodianOrg();
    const attesterOrgRes = buildAttesterOrg();
    const invoiceRes = buildInvoiceResource();
    const { binaries, docRefs } = await buildDocAndBinaryResources();
    const compositionRes = buildComposition(docRefs);

    // Compose Bundle
    const bundleId = `InvoiceBundle-${uuidv4()}`;
    const bundle = {
      resourceType: "Bundle",
      id: bundleId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Bundle"], lastUpdated: isoWithLocalOffsetFromDate(new Date()) },
      identifier: { system: "urn:ietf:rfc:3986", value: `urn:uuid:${uuidv4()}` },
      type: "document",
      timestamp: isoWithLocalOffsetFromDate(new Date()),
      entry: [
        { fullUrl: `urn:uuid:${compositionRes.id}`, resource: compositionRes },
        { fullUrl: `urn:uuid:${patientRes.id}`, resource: patientRes },
        { fullUrl: `urn:uuid:${practitionerRes.id}`, resource: practitionerRes },
        { fullUrl: `urn:uuid:${invoiceRes.id}`, resource: invoiceRes },
      ],
    };

    // Optional adds
    if (encounterRes) bundle.entry.push({ fullUrl: `urn:uuid:${encounterRes.id}`, resource: encounterRes });
    if (custodianRes) bundle.entry.push({ fullUrl: `urn:uuid:${custodianRes.id}`, resource: custodianRes });
    if (attesterOrgRes) bundle.entry.push({ fullUrl: `urn:uuid:${attesterOrgRes.id}`, resource: attesterOrgRes });

    // Documents
    docRefs.forEach(dr => bundle.entry.push({ fullUrl: `urn:uuid:${dr.id}`, resource: dr }));
    binaries.forEach(b => bundle.entry.push({ fullUrl: `urn:uuid:${b.id}`, resource: b }));

    // Submit
    const originalPatientId = String(selectedPatient?.id || "");
    axios.post("https://uat.discharge.org.in/api/v5/fhir-bundle", { bundle, patient: originalPatientId })
      .then(response => {
        console.log("FHIR Bundle Submitted:", response.data);
        alert("Submitted successfully");
      })
      .catch(error => {
        console.error("Error submitting FHIR Bundle:", error.response?.data || error.message);
        alert("Failed to submit FHIR Bundle. See console.");
        console.log("FHIR Bundle failed to submit:", { bundle, patient: originalPatientId });
      });
  }

  /* --------------------------------- UI ------------------------------------ */
  return (
    <div className="container py-4">
      <h2 className="mb-3">Invoice Record — Builder</h2>

      {/* 1. Patient */}
      <div className="card mb-3">
        <div className="card-header">1. Patient <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3 mb-2">
            <div className="col-md-8">
              <label className="form-label">Select Patient</label>
              <select className="form-select" value={selectedPatientIdx} onChange={e => setSelectedPatientIdx(Number(e.target.value))}>
                {patients.map((p, i) => <option key={p.id || i} value={i}>{p.name} {p.abha_ref ? `(${p.abha_ref})` : ""}</option>)}
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label">ABHA Address</label>
              <select className="form-select" value={selectedAbha} onChange={e => setSelectedAbha(e.target.value)} disabled={!abhaOptions.length}>
                {abhaOptions.length === 0 ? <option value="">No ABHA</option> : abhaOptions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {selectedPatient && (
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Name</label>
                <input className="form-control" readOnly value={selectedPatient.name || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Gender</label>
                <input className="form-control" readOnly value={selectedPatient.gender || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">DOB</label>
                <input className="form-control" readOnly value={selectedPatient.dob || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Mobile</label>
                <input className="form-control" readOnly value={selectedPatient.mobile || ""} />
              </div>
              <div className="col-12">
                <label className="form-label">Address</label>
                <textarea className="form-control" rows={2} readOnly value={selectedPatient.address || ""} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Practitioner (global) */}
      <div className="card mb-3">
        <div className="card-header">2. Practitioner (Author) <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Practitioner</label>
              <input className="form-control" readOnly value={practitionerDisplayName} />
            </div>
            <div className="col-md-6">
              <label className="form-label">License</label>
              <input className="form-control" readOnly value={practitionerLicense} />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Composition metadata */}
      <div className="card mb-3">
        <div className="card-header">3. Composition Metadata</div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-3">
              <label className="form-label">Status</label>
              <select className="form-select" value={status} onChange={e => setStatus(e.target.value)}>
                <option value="preliminary">preliminary</option>
                <option value="final">final</option>
                <option value="amended">amended</option>
                <option value="entered-in-error">entered-in-error</option>
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">Title</label>
              <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Date/Time</label>
              <input type="datetime-local" className="form-control" value={dateTimeLocal} onChange={e => setDateTimeLocal(e.target.value)} />
            </div>

            <div className="col-md-6">
              <label className="form-label">Encounter (optional)</label>
              <input className="form-control" value={encounterText} onChange={e => setEncounterText(e.target.value)} placeholder="Encounter reference text (optional)" />
            </div>
            <div className="col-md-6">
              <label className="form-label">Custodian Organization (optional)</label>
              <input className="form-control" value={custodianName} onChange={e => setCustodianName(e.target.value)} placeholder="Organization name (optional)" />
            </div>
          </div>
        </div>
      </div>

      {/* 4. Attester (optional) */}
      <div className="card mb-3">
        <div className="card-header">4. Attester (optional)</div>
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Mode</label>
              <select className="form-select" value={attesterMode} onChange={e => setAttesterMode(e.target.value)}>
                <option value="personal">personal</option>
                <option value="professional">professional</option>
                <option value="legal">legal</option>
                <option value="official">official</option>
              </select>
            </div>

            <div className="col-md-3">
              <label className="form-label">Party type</label>
              <select className="form-select" value={attesterPartyType} onChange={e => setAttesterPartyType(e.target.value)}>
                <option value="Practitioner">Practitioner</option>
                <option value="Organization">Organization</option>
              </select>
            </div>

            {attesterPartyType === "Organization" && (
              <div className="col-md-6">
                <label className="form-label">Attester Organization name</label>
                <input className="form-control" value={attesterOrgName} onChange={e => setAttesterOrgName(e.target.value)} placeholder="Organization name (optional)" />
              </div>
            )}
            {attesterPartyType === "Practitioner" && (
              <div className="col-md-6">
                <label className="form-label">Attester Practitioner (read-only)</label>
                <input className="form-control" readOnly value={practitionerDisplayName} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 5. Invoice lines */}
      <div className="card mb-3">
        <div className="card-header">5. Invoice lines (one or more)</div>
        <div className="card-body">
          {lines.map((l, i) => (
            <div key={i} className="border rounded p-2 mb-2">
              <div className="row g-2 align-items-end">
                <div className="col-md-6">
                  <label className="form-label">Description</label>
                  <input className="form-control" value={l.description} onChange={e => updateLine(i, "description", e.target.value)} placeholder="Service / Item" />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Quantity</label>
                  <input className="form-control" type="number" min={0} value={l.quantity} onChange={e => updateLine(i, "quantity", e.target.value)} />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Unit price (₹)</label>
                  <input className="form-control" type="number" min={0} step="0.01" value={l.unitPrice} onChange={e => updateLine(i, "unitPrice", e.target.value)} />
                </div>
              </div>
              <div className="mt-2 d-flex justify-content-between">
                <div className="text-muted">Line total: ₹{(((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0))).toFixed(2)}</div>
                <button className="btn btn-danger btn-sm" onClick={() => removeLine(i)} disabled={lines.length === 1}>Remove</button>
              </div>
            </div>
          ))}
          <button className="btn btn-sm btn-outline-secondary" onClick={addLine}>+ Add line</button>
          <div className="mt-2 fw-semibold">Grand total: ₹{invoiceTotal.toFixed(2)}</div>
          <div className="form-text mt-1">Add at least one line with amount 0 or attach a document to satisfy section entry requirement.</div>
        </div>
      </div>

      {/* 6. Documents (optional) */}
      <div className="card mb-3">
        <div className="card-header">6. Documents (optional) — DocumentReference + Binary</div>
        <div className="card-body">
          <div className="mb-2">
            <label className="form-label">Upload PDF / JPG / JPEG (multiple)</label>
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" multiple onChange={onFilesPicked} />
          </div>
          {filePreviewNames.length === 0 ? (
            <div className="text-muted">No files selected — a placeholder PDF will be embedded automatically.</div>
          ) : (
            <ul className="list-group">
              {filePreviewNames.map((n, i) => (
                <li className="list-group-item d-flex justify-content-between align-items-center" key={i}>
                  {n}
                  <button className="btn btn-sm btn-danger" onClick={() => removeFileAtIndex(i)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mb-4 d-flex justify-content-between align-items-center">
        <div className="fw-semibold">Total payable: ₹{invoiceTotal.toFixed(2)}</div>
        <button className="btn btn-primary" onClick={onBuildBundle}>Submit</button>
      </div>
    </div>
  );
}