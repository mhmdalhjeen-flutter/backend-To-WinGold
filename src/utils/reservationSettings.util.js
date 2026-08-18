const { assertNoMongoOperators, cleanString } = require("./inputSecurity.util");

const FIELD_TYPES = Object.freeze(["text", "phone", "number", "date", "time", "textarea", "note"]);
const INPUT_FIELD_TYPES = Object.freeze(["text", "phone", "number", "date", "time", "textarea"]);
const MAX_FIELDS = 20;
const MAX_LABEL = 80;
const MAX_VALUE = 500;
const MAX_NOTE_CONTENT = 500;
const MAX_FIELD_ID = 80;
const NOTE_LABEL = "ملاحظة";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function defaultReservationSettings() {
  return { enabled: false, fields: [] };
}

function isReservationNoteField(field) {
  return String(field?.type || "") === "note";
}

function normalizeFieldType(raw) {
  const type = cleanString(raw, { field: "type", max: 20 }) || "text";
  if (type === "long_text" || type === "longtext" || type === "long text") return "textarea";
  if (type === "ملاحظة") return "note";
  return FIELD_TYPES.includes(type) ? type : "text";
}

function normalizeField(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("حقل الحجز غير صالح"), { status: 400 });
  }
  assertNoMongoOperators(raw, "reservationField");

  const id = cleanString(raw.id || raw.fieldId, { field: "fieldId", max: MAX_FIELD_ID })
    || `field-${index}`;
  const type = normalizeFieldType(raw.type);
  const order = Number.isInteger(Number(raw.order)) ? Number(raw.order) : index;

  if (type === "note") {
    let content = cleanString(raw.content, { field: "content", max: MAX_NOTE_CONTENT });
    const labelRaw = cleanString(raw.label || raw.name, { field: "label", max: MAX_LABEL });
    if (!content) content = labelRaw;
    if (!content) {
      throw Object.assign(new Error("نص الملاحظة مطلوب"), { status: 400 });
    }
    return {
      id,
      label: labelRaw || NOTE_LABEL,
      type,
      required: false,
      content,
      order,
    };
  }

  const label = cleanString(raw.label || raw.name, { field: "label", max: MAX_LABEL, required: true });
  return { id, label, type, required: !!raw.required, order };
}

function normalizeReservationSettings(raw) {
  if (raw == null || raw === "") {
    return defaultReservationSettings();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("إعدادات الحجز غير صالحة"), { status: 400 });
  }
  assertNoMongoOperators(raw, "reservationSettings");

  const enabled = !!raw.enabled;
  const list = Array.isArray(raw.fields) ? raw.fields : [];
  if (list.length > MAX_FIELDS) {
    throw Object.assign(new Error("عدد حقول الحجز أكبر من المسموح"), { status: 400 });
  }

  const fields = list.map((field, index) => normalizeField(field, index));
  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.id)) {
      throw Object.assign(new Error("معرّف حقل الحجز مكرر"), { status: 400 });
    }
    seen.add(field.id);
  }
  fields.sort((a, b) => a.order - b.order);
  return { enabled, fields };
}

function coerceAnswerValue(type, value, label) {
  if (value == null) return "";
  const cleaned = cleanString(value, { field: label || "value", max: MAX_VALUE });
  if (!cleaned) return "";

  if (type === "number") {
    const parsed = Number(String(cleaned).replace(",", "."));
    if (!Number.isFinite(parsed)) {
      throw Object.assign(new Error(`${label || "الحقل"} يجب أن يكون رقماً`), { status: 400 });
    }
    return String(parsed);
  }
  if (type === "date" && !DATE_RE.test(cleaned)) {
    throw Object.assign(new Error(`${label || "التاريخ"} غير صالح`), { status: 400 });
  }
  if (type === "time" && !TIME_RE.test(cleaned)) {
    throw Object.assign(new Error(`${label || "الوقت"} غير صالح`), { status: 400 });
  }
  return cleaned;
}

function isReservationEnabled(settings) {
  return !!(settings && settings.enabled === true);
}

function buildReservationAnswers(settings, submitted) {
  if (!isReservationEnabled(settings)) {
    throw Object.assign(new Error("الحجز غير متاح لهذا العنصر"), { status: 400 });
  }

  const submittedList = Array.isArray(submitted) ? submitted : [];
  assertNoMongoOperators(submittedList, "answers");
  if (submittedList.length > MAX_FIELDS) {
    throw Object.assign(new Error("عدد الإجابات أكبر من المسموح"), { status: 400 });
  }

  const byId = new Map();
  for (const answer of submittedList) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) continue;
    assertNoMongoOperators(answer, "answer");
    const fieldId = cleanString(answer.fieldId || answer.id, { field: "fieldId", max: MAX_FIELD_ID });
    if (!fieldId) continue;
    byId.set(fieldId, answer);
  }

  const inputFields = (settings.fields || []).filter((field) => !isReservationNoteField(field));
  const noteIds = new Set((settings.fields || []).filter(isReservationNoteField).map((field) => field.id));
  const configuredIds = new Set(inputFields.map((field) => field.id));
  for (const fieldId of byId.keys()) {
    if (noteIds.has(fieldId)) continue;
    if (!configuredIds.has(fieldId)) {
      throw Object.assign(new Error("تم إرسال حقول غير مسموحة"), { status: 400 });
    }
  }

  return inputFields.map((field) => {
    const raw = byId.get(field.id);
    const value = coerceAnswerValue(field.type, raw?.value, field.label);
    if (field.required && !value) {
      throw Object.assign(new Error(`${field.label} مطلوب`), { status: 400 });
    }
    return {
      fieldId: field.id,
      label: field.label,
      type: field.type,
      value,
    };
  });
}

function normalizeSelectedVariant(raw) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  assertNoMongoOperators(raw, "variant");
  const id = cleanString(raw.id, { field: "variantId", max: 80 });
  const name = cleanString(raw.name, { field: "variantName", max: 80 });
  const values = cleanString(raw.values || raw.value, { field: "variantValue", max: 120 });
  if (!id && !name && !values) return undefined;
  return { id, name, values };
}

module.exports = {
  FIELD_TYPES,
  INPUT_FIELD_TYPES,
  MAX_FIELDS,
  MAX_LABEL,
  MAX_VALUE,
  MAX_NOTE_CONTENT,
  buildReservationAnswers,
  defaultReservationSettings,
  isReservationEnabled,
  isReservationNoteField,
  normalizeReservationSettings,
  normalizeSelectedVariant,
};
