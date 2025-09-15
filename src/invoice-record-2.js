// src/App.js
import React, { useEffect, useState } from "react";
import "bootstrap/dist/css/bootstrap.min.css";

/* ---------- Utilities ---------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }).toLowerCase();
}
function toFhirDate(input) {
  if (!input) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const m = input.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (m) {
    let dd = m[1].padStart(2, "0");
    let mm = m[2].padStart(2, "0");
    let yy = m[3].length === 2 ? "19" + m[3] : m[3];
    return `${yy}-${mm}-${dd}`;
  }
  const d = new Date(input);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return undefined;
}
function getAbhaAddressesForPatient(pt) {
  if (!pt) return [];
  const arr = pt.additional_attributes?.abha_addresses ?? [];
  const normalized = (arr || []).map((a) => {
    if (!a) return null;
    if (typeof a === "string") return a;
    if (typeof a === "object") return a.address ?? JSON.stringify(a);
    return String(a);
  }).filter(Boolean);
  if (pt.abha_ref && !normalized.includes(pt.abha_ref)) normalized.unshift(pt.abha_ref);
  return Array.from(new Set(normalized));
}

/* ---------- Defaults ---------- */
const DEFAULT_PRACTITIONER = { id: uuidv4(), name: "Dr. ABC", license: "LIC-1234" };

/* ---------- App ---------- */
export default function App() {
  const [patients, setPatients] = useState([]);
  const [loadingPatients, setLoadingPatients] = useState(true);

  const [selectedPatientIdx, setSelectedPatientIdx] = useState(null);
  const [selectedAbha, setSelectedAbha] = useState("");

  const [practitioner, setPractitioner] = useState({ ...DEFAULT_PRACTITIONER });

  const [organization, setOrganization] = useState({
    id: uuidv4(),
    name: "Default Hospital",
    gstin: "",
    phone: "",
    address: ""
  });

  const [invoiceNumber, setInvoiceNumber] = useState(`INV-${Date.now()}`);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceType, setInvoiceType] = useState("healthcare");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("pending");

  const [lineItems, setLineItems] = useState([{ id: uuidv4(), description: "Consultation", quantity: 1, unit: "each", unitPrice: 500, taxPercent: 0 }]);

  const [totalNet, setTotalNet] = useState("");
  const [totalTax, setTotalTax] = useState("");
  const [totalGross, setTotalGross] = useState("");

  const [attachments, setAttachments] = useState([]);
  const [generatedBundleJson, setGeneratedBundleJson] = useState("");

  /* ---------- fetch patients.json (public folder) ---------- */
  useEffect(() => {
    let mounted = true;
    fetch("/patients.json")
      .then((r) => {
        if (!r.ok) throw new Error("patients.json not found");
        return r.json();
      })
      .then((data) => {
        if (!mounted) return;
        setPatients(Array.isArray(data) ? data : [data]);
      })
      .catch((err) => {
        console.warn("Could not fetch /patients.json:", err);
        setPatients([]);
      })
      .finally(() => mounted && setLoadingPatients(false));
    return () => (mounted = false);
  }, []);

  /* ---------- line item handlers ---------- */
  function addLineItem() {
    setLineItems((s) => [...s, { id: uuidv4(), description: "", quantity: 1, unit: "each", unitPrice: 0, taxPercent: 0 }]);
  }
  function updateLineItem(id, patch) {
    setLineItems((s) => s.map((li) => (li.id === id ? { ...li, ...patch } : li)));
  }
  function removeLineItem(id) {
    setLineItems((s) => (s.length <= 1 ? s : s.filter((li) => li.id !== id)));
  }

  /* ---------- attachments ---------- */
  function handleFileChange(ev) {
    const files = Array.from(ev.target.files || []);
    files.forEach((f) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target.result.split(",")[1];
        setAttachments((s) => [...s, { id: uuidv4(), name: f.name, contentType: f.type || "application/octet-stream", data: base64 }]);
      };
      reader.readAsDataURL(f);
    });
    ev.target.value = null;
  }
  function removeAttachment(id) {
    setAttachments((s) => s.filter((a) => a.id !== id));
  }

  /* ---------- auto compute totals ---------- */
  useEffect(() => {
    const base = lineItems.reduce((acc, li) => acc + Number(li.quantity || 0) * Number(li.unitPrice || 0), 0);
    const tax = lineItems.reduce((acc, li) => {
      const b = Number(li.quantity || 0) * Number(li.unitPrice || 0);
      return acc + (b * (Number(li.taxPercent || 0) / 100));
    }, 0);
    setTotalNet(base.toFixed(2));
    setTotalTax(tax.toFixed(2));
    setTotalGross((base + tax).toFixed(2));
  }, [lineItems]);

  /* ---------- build FHIR bundle ---------- */
  function buildBundle() {
    if (selectedPatientIdx === null) { alert("Please select a patient and ABHA address."); return null; }
    const selPatient = patients[selectedPatientIdx];
    if (!selPatient) { alert("Selected patient not found."); return null; }
    if (!selectedAbha) { alert("Please select an ABHA address."); return null; }

    const patientId = (selPatient.user_ref_id && typeof selPatient.user_ref_id === "string") ? selPatient.user_ref_id.toLowerCase() : uuidv4();
    const compId = uuidv4();
    const practId = (practitioner.id && practitioner.id.length > 0) ? practitioner.id.toLowerCase() : uuidv4();
    const orgId = organization.id || uuidv4();
    const invoiceId = uuidv4();

    // Patient resource
    const patientResource = {
      resourceType: "Patient",
      id: patientId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Patient"] },
      identifier: [
        {
          system: "http://terminology.hl7.org/CodeSystem/v2-0203",
          value: selPatient.user_ref_id || `mrn-${selPatient.id}`,
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical record number" }], text: "MR" }
        },
        {
          system: "http://nrces.in/CodeSystem/identifier-type",
          value: selectedAbha,
          type: { coding: [{ system: "http://nrces.in/CodeSystem/identifier-type", code: "ABHA", display: "ABHA Address" }], text: "ABHA" }
        }
      ],
      name: [{ text: selPatient.name || "" }],
      gender: selPatient.gender ? selPatient.gender.toLowerCase() : undefined,
      birthDate: toFhirDate(selPatient.dob),
      telecom: [
        ...(selPatient.mobile ? [{ system: "phone", value: selPatient.mobile, use: "mobile" }] : []),
        ...(selPatient.email ? [{ system: "email", value: selPatient.email }] : [])
      ],
      address: selPatient.address ? [{ text: selPatient.address }] : undefined,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Patient: ${selPatient.name}</p></div>` }
    };

    // Practitioner resource — qualification display must match HL7 allowed text
    const practitionerResource = {
      resourceType: "Practitioner",
      id: practId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner"] },
      identifier: [
        { system: "http://nrces.in/CodeSystem/identifier-type", value: `PR-${practId}`, type: { coding: [{ system: "http://nrces.in/CodeSystem/identifier-type", code: "PR", display: "Practitioner" }], text: "PR" } }
      ],
      name: [{ text: practitioner.name || "Unknown Practitioner" }],
      qualification: practitioner.license ? [
        {
          identifier: [{ system: "http://your.org/licenses", value: practitioner.license }],
          code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0360", code: "MD", display: "Doctor of Medicine" }], text: "Medical License" }
        }
      ] : undefined,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${practitioner.name}</p></div>` }
    };

    // Organization resource
    const organizationResource = {
      resourceType: "Organization",
      id: orgId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Organization"] },
      identifier: [
        { system: "http://nrces.in/CodeSystem/identifier-type", value: "ORG-001", type: { coding: [{ system: "http://nrces.in/CodeSystem/identifier-type", code: "ORG", display: "Organization" }], text: "ORG" } },
        ...(organization.gstin ? [{ system: "http://your.org/gstin", value: organization.gstin, type: { text: "GSTIN" } }] : [])
      ],
      name: organization.name,
      telecom: organization.phone ? [{ system: "phone", value: organization.phone }] : undefined,
      address: organization.address ? [{ text: organization.address }] : undefined,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${organization.name}</p></div>` }
    };

    // Build invoice lineItems (only allowed properties)
    const processedLineItems = lineItems.map((li, idx) => {
      const qty = Number(li.quantity || 0);
      const unitPrice = Number(li.unitPrice || 0);
      const base = qty * unitPrice;
      const tax = base * (Number(li.taxPercent || 0) / 100);
      const components = [
        { type: "base", code: { coding: [{ system: "http://nrces.in/CodeSystem/price-component", code: "base-price", display: "Base price" }], text: "Base price" }, amount: { value: Number(base.toFixed(2)), currency: "INR" } }
      ];
      if (tax > 0) {
        components.push({ type: "tax", code: { coding: [{ system: "http://nrces.in/CodeSystem/price-component", code: "gst", display: "GST" }], text: "GST" }, amount: { value: Number(tax.toFixed(2)), currency: "INR" } });
      }
      // compose a text description that includes quantity/unit
      const textDesc = li.description ? `${li.description} (${qty} ${li.unit || "unit"})` : `${qty} x ${li.unit || "unit"}`;
      return {
        sequence: idx + 1,
        chargeItemCodeableConcept: {
          coding: [{ system: "http://nrces.in/CodeSystem/invoice-item", code: `item-${idx + 1}`, display: li.description || `Item ${idx + 1}` }],
          text: textDesc
        },
        priceComponent: components
      };
    });

    // Totals from computed or overrides
    const computedNet = processedLineItems.reduce((s, it) => s + ((it.priceComponent || []).find(c => c.type === "base")?.amount?.value || 0), 0);
    const computedTax = processedLineItems.reduce((s, it) => s + ((it.priceComponent || []).find(c => c.type === "tax")?.amount?.value || 0), 0);
    const computedGross = computedNet + computedTax;

    const finalNet = totalNet && !isNaN(Number(totalNet)) ? Number(totalNet) : Number(computedNet.toFixed(2));
    const finalTax = totalTax && !isNaN(Number(totalTax)) ? Number(totalTax) : Number(computedTax.toFixed(2));
    const finalGross = totalGross && !isNaN(Number(totalGross)) ? Number(totalGross) : Number(computedGross.toFixed(2));

    // Invoice resource (no invalid properties)
    const invoiceResource = {
      resourceType: "Invoice",
      id: invoiceId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Invoice"] },
      identifier: [{ system: "https://your.hospital.org/invoices", value: invoiceNumber || `INV-${invoiceId}` }],
      status: "issued",
      type: { coding: [{ system: "http://nrces.in/CodeSystem/invoice-type", code: invoiceType, display: "Invoice Type" }], text: invoiceType },
      date: invoiceDate || new Date().toISOString(),
      subject: { reference: `urn:uuid:${patientId}`, display: selPatient.name },
      recipient: { reference: `urn:uuid:${patientId}` },
      issuer: { reference: `urn:uuid:${orgId}` },
      paymentTerms: paymentTerms || undefined,
      // paymentStatus is not a standard Invoice element — move to note
      note: paymentStatus ? [{ text: `Payment status: ${paymentStatus}` }] : undefined,
      totalNet: { value: Number(finalNet.toFixed(2)), currency: "INR" },
      totalGross: { value: Number(finalGross.toFixed(2)), currency: "INR" },
      lineItem: processedLineItems,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Invoice ${invoiceNumber}</p></div>` }
    };

    // Composition for InvoiceRecord
    const compositionResource = {
      resourceType: "Composition",
      id: compId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/InvoiceRecord"] },
      status: "final",
      type: { coding: [{ system: "http://nrces.in/CodeSystem/document-type", code: "INVR", display: "Invoice Record" }], text: "Invoice Record" },
      title: `Invoice ${invoiceNumber}`,
      date: new Date().toISOString(),
      subject: { reference: `urn:uuid:${patientId}`, display: selPatient.name },
      // IMPORTANT: author must reference "Practitioner/<id>" so validator can match profile
      author: [{ reference: `urn:uuid:${practId}`, display: practitioner.name }],
      attester: [{ mode: "official", party: { reference: `urn:uuid:${practId}` }, time: new Date().toISOString() }],
      section: [
        {
          title: "Invoice Section",
          code: { coding: [{ system: "http://nrces.in/CodeSystem/section-type", code: "invoice", display: "Invoice" }], text: "Invoice" },
          text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Invoice details</p></div>` },
          entry: [{ reference: `urn:uuid:${invoiceId}`, type: "Invoice" }]
        }
      ],
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Invoice for ${selPatient.name}</p></div>` }
    };

    // Binary + DocumentReference for attachments
    const binaryResources = attachments.map((att) => ({ resourceType: "Binary", id: att.id, contentType: att.contentType, data: att.data }));
    const docRefs = attachments.map((att) => ({
      resourceType: "DocumentReference",
      id: `doc-${att.id}`,
      status: "current",
      docStatus: "final",
      type: { text: att.name },
      content: [{ attachment: { url: `urn:uuid:${att.id}`, title: att.name, creation: new Date().toISOString() } }],
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${att.name}</p></div>` }
    }));

    // Build bundle entries (fullUrl = urn:uuid:<id>)
    const entries = [
      { fullUrl: `urn:uuid:${compId}`, resource: compositionResource },
      { fullUrl: `urn:uuid:${patientId}`, resource: patientResource },
      { fullUrl: `urn:uuid:${practId}`, resource: practitionerResource },
      { fullUrl: `urn:uuid:${orgId}`, resource: organizationResource },
      { fullUrl: `urn:uuid:${invoiceId}`, resource: invoiceResource },
      ...binaryResources.map(br => ({ fullUrl: `urn:uuid:${br.id}`, resource: br })),
      ...docRefs.map(dr => ({ fullUrl: `urn:uuid:${dr.id}`, resource: dr }))
    ];

    const bundle = {
      resourceType: "Bundle",
      id: uuidv4(),
      type: "document",
      timestamp: new Date().toISOString(),
      identifier: { system: "urn:uuid", value: `invoice-bundle-${Date.now()}` },
      entry: entries
    };

    setGeneratedBundleJson(JSON.stringify(bundle, null, 2));
    console.log("Generated bundle", bundle);
    return bundle;
  }

  function downloadBundle() {
    if (!generatedBundleJson) { alert("Generate a bundle first."); return; }
    const blob = new Blob([generatedBundleJson], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-bundle-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------- UI ---------- */
  return (
    <div className="container my-4">
      <h3>Invoice Record — Builder (NDHM)</h3>
      <p className="text-muted">Select patient → ABHA → fill invoice, add items/tax, attach files, generate FHIR Bundle.</p>

      {/* Patient */}
      <div className="card mb-3"><div className="card-body">
        <h5>1. Patient</h5>
        <div className="row g-2">
          <div className="col-md-6">
            <label className="form-label">Patient *</label>
            <select className="form-select" value={selectedPatientIdx ?? ""} onChange={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); setSelectedPatientIdx(v); setSelectedAbha(""); }}>
              <option value="">-- select patient --</option>
              {loadingPatients ? <option>Loading...</option> : patients.map((p, i) => <option key={i} value={i}>{p.name}{p.abha_ref ? ` (${p.abha_ref})` : ""}</option>)}
            </select>
          </div>
          <div className="col-md-6">
            <label className="form-label">ABHA *</label>
            <select className="form-select" disabled={selectedPatientIdx === null} value={selectedAbha} onChange={(e) => setSelectedAbha(e.target.value)}>
              <option value="">-- select ABHA --</option>
              {selectedPatientIdx !== null && getAbhaAddressesForPatient(patients[selectedPatientIdx]).map((a, idx) => <option key={idx} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
        {selectedPatientIdx !== null && <div className="mt-2"><small className="text-muted">Selected: {patients[selectedPatientIdx].name} • {patients[selectedPatientIdx].gender} • DOB: {patients[selectedPatientIdx].dob}</small></div>}
      </div></div>

      {/* Practitioner */}
      <div className="card mb-3"><div className="card-body">
        <h5>2. Practitioner</h5>
        <div className="row g-2">
          <div className="col-md-5"><label className="form-label">Name *</label><input className="form-control" value={practitioner.name} onChange={(e) => setPractitioner(p => ({ ...p, name: e.target.value }))} /></div>
          <div className="col-md-4"><label className="form-label">License *</label><input className="form-control" value={practitioner.license} onChange={(e) => setPractitioner(p => ({ ...p, license: e.target.value }))} /></div>
          <div className="col-md-3"><label className="form-label">Practitioner ID</label><input className="form-control" value={practitioner.id} readOnly /></div>
        </div>
      </div></div>

      {/* Organization */}
      <div className="card mb-3"><div className="card-body">
        <h5>3. Issuer Organization</h5>
        <div className="row g-2">
          <div className="col-md-6"><label className="form-label">Name</label><input className="form-control" value={organization.name} onChange={(e) => setOrganization(o => ({ ...o, name: e.target.value }))} /></div>
          <div className="col-md-3"><label className="form-label">GSTIN</label><input className="form-control" value={organization.gstin} onChange={(e) => setOrganization(o => ({ ...o, gstin: e.target.value }))} /></div>
          <div className="col-md-3"><label className="form-label">Phone</label><input className="form-control" value={organization.phone} onChange={(e) => setOrganization(o => ({ ...o, phone: e.target.value }))} /></div>
          <div className="col-md-12 mt-2"><label className="form-label">Address</label><input className="form-control" value={organization.address} onChange={(e) => setOrganization(o => ({ ...o, address: e.target.value }))} /></div>
        </div>
      </div></div>

      {/* Invoice */}
      <div className="card mb-3"><div className="card-body">
        <h5>4. Invoice</h5>
        <div className="row g-2">
          <div className="col-md-4"><label className="form-label">Invoice No *</label><input className="form-control" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} /></div>
          <div className="col-md-3"><label className="form-label">Date *</label><input type="date" className="form-control" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></div>
          <div className="col-md-5"><label className="form-label">Type</label><select className="form-select" value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}><option value="healthcare">Healthcare</option><option value="pharmacy">Pharmacy</option><option value="other">Other</option></select></div>
        </div>

        <div className="row g-2 mt-2">
          <div className="col-md-6"><label className="form-label">Payment terms</label><input className="form-control" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} /></div>
          <div className="col-md-3"><label className="form-label">Payment status</label><select className="form-select" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}><option value="pending">Pending</option><option value="paid">Paid</option><option value="partially-paid">Partially paid</option></select></div>
          <div className="col-md-3"><label className="form-label">Notes</label><input className="form-control" placeholder="Optional note" onChange={() => {}} /></div>
        </div>

        <hr />
        <h6>Line items</h6>
        {lineItems.map((li) => (
          <div className="row g-2 align-items-end mb-2" key={li.id}>
            <div className="col-md-5"><label className="form-label">Description</label><input className="form-control" value={li.description} onChange={(e) => updateLineItem(li.id, { description: e.target.value })} /></div>
            <div className="col-md-2"><label className="form-label">Qty</label><input type="number" className="form-control" value={li.quantity} onChange={(e) => updateLineItem(li.id, { quantity: Number(e.target.value) })} /></div>
            <div className="col-md-2"><label className="form-label">Unit</label><input className="form-control" value={li.unit} onChange={(e) => updateLineItem(li.id, { unit: e.target.value })} /></div>
            <div className="col-md-2"><label className="form-label">Unit price (INR)</label><input type="number" className="form-control" value={li.unitPrice} onChange={(e) => updateLineItem(li.id, { unitPrice: Number(e.target.value) })} /></div>
            <div className="col-md-1"><label className="form-label">Tax %</label><input type="number" className="form-control" value={li.taxPercent} onChange={(e) => updateLineItem(li.id, { taxPercent: Number(e.target.value) })} /></div>
            <div className="col-md-12 mt-1 d-flex gap-2"><button className="btn btn-danger" onClick={() => removeLineItem(li.id)} disabled={lineItems.length <= 1}>Remove</button>{li === lineItems[lineItems.length - 1] && <button className="btn btn-secondary" onClick={addLineItem}>+ Add item</button>}</div>
          </div>
        ))}

        <div className="row mt-3">
          <div className="col-md-3"><label className="form-label">Total Net (INR)</label><input className="form-control" value={totalNet} onChange={(e) => setTotalNet(e.target.value)} /></div>
          <div className="col-md-3"><label className="form-label">Total Tax (INR)</label><input className="form-control" value={totalTax} onChange={(e) => setTotalTax(e.target.value)} /></div>
          <div className="col-md-3"><label className="form-label">Total Gross (INR)</label><input className="form-control" value={totalGross} onChange={(e) => setTotalGross(e.target.value)} /></div>
        </div>

        <div className="mt-3">
          <label className="form-label">Attachments</label>
          <input type="file" className="form-control" onChange={handleFileChange} multiple />
          <div className="mt-2">{attachments.map((a) => (<div key={a.id} className="d-flex justify-content-between align-items-center border rounded p-2 mb-1"><div><strong>{a.name}</strong> <small className="text-muted">({a.contentType})</small></div><div><button className="btn btn-sm btn-danger" onClick={() => removeAttachment(a.id)}>Remove</button></div></div>))}</div>
        </div>

        <div className="mt-3">
          <button className="btn btn-primary me-2" onClick={() => buildBundle()}>Generate Bundle</button>
          <button className="btn btn-outline-secondary" onClick={() => downloadBundle()} disabled={!generatedBundleJson}>Download Bundle</button>
        </div>

      </div></div>

      <div className="card mb-5"><div className="card-body">
        <h5>Generated bundle (preview)</h5>
        {!generatedBundleJson ? <div className="text-muted">No bundle generated yet.</div> : <pre style={{ maxHeight: 420, overflow: "auto", background: "#f8f9fa", padding: 12 }}>{generatedBundleJson}</pre>}
      </div></div>

      <footer className="text-muted small">Notes: This version fixes the validator issues you reported (author/attester references, qualification display, invalid invoice fields). You may still see **warnings** for NDHM code systems (expected). If you want me to swap some NDHM code systems to HL7 to reduce warnings, say the word and I’ll produce that variant.</footer>
    </div>
  );
}
