import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient";

const FOREST = "#1a6b3a";
const BRICK = "#b85a2a";

// ── Thai month names ──────────────────────────────────────────────────────────
const THAI_MONTHS = {
  "ม.ค.": "01","ก.พ.": "02","มี.ค.": "03","เม.ย.": "04",
  "พ.ค.": "05","มิ.ย.": "06","ก.ค.": "07","ส.ค.": "08",
  "ก.ย.": "09","ต.ค.": "10","พ.ย.": "11","ธ.ค.": "12",
};

// ── Detect formats ────────────────────────────────────────────────────────────
function isAgodaFormat(headers) {
  const flat = headers.map(h => String(h || "").trim());
  return flat.some(h => /หมายเลขการจอง/i.test(h)) &&
         flat.some(h => /ชื่อผู้เข้าพัก/i.test(h)) &&
         flat.some(h => /วันเข้าพัก/i.test(h)); // combined date column = Agoda style
}

function isBookingFormat(headers) {
  const flat = headers.map(h => String(h || "").trim());
  return flat.some(h => /ชื่อผู้เข้าพัก/i.test(h)) &&
         flat.some(h => /เช็คอิน/i.test(h)) &&
         flat.some(h => /เช็คเอาท์/i.test(h));
}

// ── Parse Thai date "5 พ.ค. 2025" → "2025-05-05" ─────────────────────────────
function parseThaiDate(s) {
  if (!s) return "";
  const m = String(s).trim().match(/^(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return "";
  const mm = THAI_MONTHS[m[2]];
  if (!mm) return "";
  let y = parseInt(m[3]);
  if (y > 2400) y -= 543;
  return `${y}-${mm}-${String(m[1]).padStart(2,"0")}`;
}

// ── Parse "5 พ.ค. 2025 - 6 พ.ค. 2025" → { checkIn, checkOut } ────────────────
function parseAgodaDateRange(s) {
  if (!s) return { checkIn: "", checkOut: "" };
  const parts = String(s).split(" - ");
  return {
    checkIn:  parseThaiDate(parts[0]),
    checkOut: parseThaiDate(parts[1]),
  };
}

// ── Parse "บ้านต้นมะเดื่อ ผู้ใหญ่ 2 คน | 1 คืน" ────────────────────────────
function parseRoomInfo(s) {
  if (!s) return { roomName: "", guests: 1, nights: 1 };
  const str = String(s).trim();
  const roomMatch = str.match(/^([^\u0e1c]+)/);         // up to "ผู้"
  const guestMatch = str.match(/ผู้ใหญ่\s*(\d+)\s*คน/);
  const nightMatch = str.match(/(\d+)\s*คืน/);
  return {
    roomName: roomMatch ? roomMatch[1].trim() : str,
    guests:   guestMatch ? parseInt(guestMatch[1]) : 1,
    nights:   nightMatch ? parseInt(nightMatch[1]) : 1,
  };
}

// ── Parse Agoda sheet ─────────────────────────────────────────────────────────
function parseAgodaRows(sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (raw.length < 2) return [];
  const headers = raw[0].map(h => String(h || "").trim());

  const idx = (patterns) => {
    for (const p of patterns) {
      const i = headers.findIndex(h => p.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };

  const bookingIdx = idx([/หมายเลขการจอง/i]);
  const nameIdx    = idx([/ชื่อผู้เข้าพัก/i]);
  const dateIdx    = idx([/วันเข้าพัก/i]);
  const roomIdx    = idx([/ห้องพัก/i]);

  const dataRows = raw.slice(1).filter(r => r.some(c => c !== ""));

  // group by name to count total visits (unique booking IDs)
  const visitMap = {};
  dataRows.forEach(r => {
    const name = String(r[nameIdx] || "").trim();
    if (!name) return;
    const bookingId = String(r[bookingIdx] || "").trim();
    if (!visitMap[name]) visitMap[name] = new Set();
    visitMap[name].add(bookingId);
  });

  // build customer list — one row per booking (for history), merged to unique customer
  const customerMap = {};
  dataRows.forEach(r => {
    const name = String(r[nameIdx] || "").trim();
    if (!name) return;
    const bookingId = String(r[bookingIdx] || "").trim();
    const { checkIn, checkOut } = parseAgodaDateRange(r[dateIdx]);
    const { roomName, guests, nights } = parseRoomInfo(r[roomIdx]);
    const visits = visitMap[name] ? visitMap[name].size : 1;

    if (!customerMap[name]) {
      customerMap[name] = {
        name,
        visits,
        bookings: [],
        tel: "", dob: "", age: "", sex: "", idNum: "",
        occ: "", bene: "", rel: "", address: "",
        biz: "", status: calcStatus(visits), med: "", note: "",
        source: "agoda",
      };
    }
    customerMap[name].bookings.push({ bookingId, checkIn, checkOut, roomName, guests, nights });
    // latest check-in as lastVisit
    if (!customerMap[name].lastCheckIn || checkIn > customerMap[name].lastCheckIn) {
      customerMap[name].lastCheckIn = checkIn;
      customerMap[name].lastRoom = roomName;
    }
  });

  return Object.values(customerMap);
}

// ── Strip guest count from name "Cheryl Lao 1 ผู้ใหญ่" → "Cheryl Lao" ─────────
function cleanBookingName(s) {
  return String(s || "").replace(/\s+\d+\s*ผู้ใหญ่.*$/i, "").trim();
}

// ── Parse room column: may be "บ้านต้นมะเดื่อ" or "1 x บ้านต้นมะเดื่อ, 1 x บ้านต้นประดู่" ──
function parseRoomColumn(s) {
  const str = String(s || "").trim();
  if (!str) return { roomName: "-", guests: 1 };
  // multi-room: "1 x บ้านต้นมะเดื่อ, 1 x บ้านต้นประดู่"
  if (/\d+\s*x\s*/i.test(str)) {
    const rooms = str.split(",").map(p => p.replace(/^\d+\s*x\s*/i, "").trim()).filter(Boolean);
    return { roomName: rooms.join(" + "), guests: rooms.length };
  }
  return { roomName: str, guests: 1 };
}

// ── Parse price "THB 365.81 " → 365.81 ────────────────────────────────────────
function parsePrice(s) {
  const m = String(s || "").match(/([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

// ── Parse Booking.com sheet ───────────────────────────────────────────────────
function parseBookingRows(sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (raw.length < 2) return [];
  const headers = raw[0].map(h => String(h || "").trim());

  const idx = (patterns) => {
    for (const p of patterns) {
      const i = headers.findIndex(h => p.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };

  const nameIdx     = idx([/ชื่อผู้เข้าพัก/i]);
  const checkInIdx  = idx([/เช็คอิน/i, /check.?in/i]);
  const checkOutIdx = idx([/วันที่เช็คเอาท์/i, /เช็คเอาท์/i, /check.?out/i]);
  const roomIdx     = idx([/ห้องพัก/i, /room/i]);
  const bookingIdx  = idx([/หมายเลขการจอง/i, /booking.*id/i]);
  const priceIdx    = idx([/^ราคา/i, /^price/i]);
  const commIdx     = idx([/คอมมิชชั่น/i, /commission/i]);

  const dataRows = raw.slice(1).filter(r => r.some(c => c !== ""));

  // visit map by cleaned name
  const visitMap = {};
  dataRows.forEach(r => {
    const name = cleanBookingName(r[nameIdx]);
    if (!name) return;
    const bookingId = String(r[bookingIdx] || "").trim();
    if (!visitMap[name]) visitMap[name] = new Set();
    visitMap[name].add(bookingId || Math.random().toString());
  });

  const customerMap = {};
  dataRows.forEach(r => {
    const name = cleanBookingName(r[nameIdx]);
    if (!name) return;
    const bookingId   = String(r[bookingIdx] || "").trim();
    const checkIn     = parseThaiDate(r[checkInIdx]);
    const checkOut    = parseThaiDate(r[checkOutIdx]);
    const { roomName, guests } = parseRoomColumn(r[roomIdx]);
    const price       = priceIdx >= 0 ? parsePrice(r[priceIdx]) : 0;
    const commission  = commIdx  >= 0 ? parseFloat(r[commIdx]) || 0 : 0;

    // calc nights from dates
    const ci = new Date(checkIn), co = new Date(checkOut);
    const nights = (!isNaN(ci) && !isNaN(co)) ? Math.round((co - ci) / 86400000) : 1;
    const visits = visitMap[name] ? visitMap[name].size : 1;

    if (!customerMap[name]) {
      customerMap[name] = {
        name, visits,
        bookings: [],
        tel: "", dob: "", age: "", sex: "", idNum: "",
        occ: "", bene: "", rel: "", address: "",
        biz: "", status: calcStatus(visits), med: "", note: "",
        source: "booking",
      };
    }
    customerMap[name].bookings.push({ bookingId, checkIn, checkOut, roomName, guests, nights, price, commission });
    if (!customerMap[name].lastCheckIn || checkIn > customerMap[name].lastCheckIn) {
      customerMap[name].lastCheckIn = checkIn;
      customerMap[name].lastRoom = roomName;
    }
  });

  return Object.values(customerMap);
}


function parseDateVal(v) {
  if (!v) return "";
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let y = parseInt(m[3]);
    if (y > 2400) y -= 543;
    else if (y < 100) y += 2000;
    return `${y}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
  }
  return s;
}

function guessAge(dobStr) {
  if (!dobStr) return "";
  const dob = new Date(dobStr);
  if (isNaN(dob)) return "";
  let age = new Date().getFullYear() - dob.getFullYear();
  const now = new Date();
  if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age--;
  return age;
}

function calcStatus(v) { return v >= 5 ? "Legend" : v >= 2 ? "Regular" : "Newbie"; }

const COL_MAP = [
  { key: "name",    patterns: [/ชื่อ.*นามสกุล/i, /^name/i, /fullname/i] },
  { key: "dob",     patterns: [/date.*birth/i, /วันเกิด/i, /\bdob\b/i, /birth/i] },
  { key: "age",     patterns: [/^age/i, /อายุ/i] },
  { key: "sex",     patterns: [/^sex/i, /^gender/i, /เพศ/i] },
  { key: "idNum",   patterns: [/passport/i, /บัตรประชาชน/i, /id.*no/i, /เลข.*บัตร/i] },
  { key: "occ",     patterns: [/occupation/i, /อาชีพ/i] },
  { key: "bene",    patterns: [/beneficiary/i, /ผู้รับผลประโยชน์/i] },
  { key: "rel",     patterns: [/relationship/i, /ความสัมพันธ์/i] },
  { key: "tel",     patterns: [/^tel/i, /phone/i, /mobile/i, /เบอร์/i] },
  { key: "address", patterns: [/address/i, /ที่อยู่/i] },
];

function detectColumns(headers) {
  const map = {};
  headers.forEach((h, idx) => {
    const hStr = String(h || "");
    for (const { key, patterns } of COL_MAP) {
      if (!map[key] && patterns.some(p => p.test(hStr))) map[key] = idx;
    }
  });
  return map;
}

function parseStandardRows(sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (raw.length < 2) return [];
  const headers = raw[0];
  const colMap = detectColumns(headers);
  return raw.slice(1).filter(r => r.some(c => c !== "")).map((r, i) => {
    const get = key => colMap[key] !== undefined ? r[colMap[key]] : "";
    const dob = parseDateVal(get("dob"));
    const age = get("age") || guessAge(dob);
    return {
      _rowNum: i,
      name: String(get("name") || "").trim(),
      dob, age: parseInt(age) || "",
      sex: String(get("sex") || "").trim(),
      idNum: String(get("idNum") || "").trim(),
      occ: String(get("occ") || "").trim(),
      bene: String(get("bene") || "").trim(),
      rel: String(get("rel") || "").trim(),
      tel: String(get("tel") || "").trim(),
      address: String(get("address") || "").trim(),
      biz: "", status: "Newbie", visits: 1, med: "", note: "",
      source: "manual", bookings: [],
    };
  }).filter(r => r.name);
}

// ── Master parser: detect format and dispatch ─────────────────────────────────
function parseRows(sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (raw.length < 2) return { rows: [], format: "unknown" };
  const headers = raw[0];
  if (isAgodaFormat(headers)) return { rows: parseAgodaRows(sheet), format: "agoda" };
  if (isBookingFormat(headers)) return { rows: parseBookingRows(sheet), format: "booking" };
  return { rows: parseStandardRows(sheet), format: "standard" };
}

// ── Badges ────────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const s = { Newbie: { bg: "#f0f0f0", c: "#666" }, Regular: { bg: "#e8f5ee", c: FOREST }, Legend: { bg: "#fff8e0", c: "#8a6500" } }[status] || { bg: "#f0f0f0", c: "#666" };
  return <span style={{ background: s.bg, color: s.c, padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{status === "Legend" ? "⭐ " : ""}{status}</span>;
}

function BizBadge({ biz }) {
  if (biz === "hike") return <span style={{ background: "#e8f5ee", color: FOREST, padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500 }}>ดงดิบ</span>;
  if (biz === "stay") return <span style={{ background: "#fdf0ea", color: BRICK, padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500 }}>สวนบ้านนอก</span>;
  return <span><span style={{ background: "#e8f5ee", color: FOREST, padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500, marginRight: 4 }}>ดงดิบ</span><span style={{ background: "#fdf0ea", color: BRICK, padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500 }}>สวนบ้านนอก</span></span>;
}

function SourceBadge({ source }) {
  if (source === "agoda") return <span style={{ background: "#fff0f0", color: "#c0392b", padding: "1px 7px", borderRadius: 20, fontSize: 10, fontWeight: 600, border: "0.5px solid #f5c6c0" }}>Agoda</span>;
  if (source === "booking") return <span style={{ background: "#f0f4ff", color: "#1a56c4", padding: "1px 7px", borderRadius: 20, fontSize: 10, fontWeight: 600, border: "0.5px solid #c0d0f5" }}>Booking.com</span>;
  return null;
}

// ── Import Modal ──────────────────────────────────────────────────────────────
function ImportModal({ pendingRows, detectedFormat, onConfirm, onCancel }) {
  const [biz, setBiz] = useState(detectedFormat === "agoda" || detectedFormat === "booking" ? "stay" : "hike");
  const [append, setAppend] = useState(true);

  const bizOptions = [
    { value: "hike", label: "ดงดิบ", sub: "ทริปเดินป่า / ผจญภัย", color: FOREST, bg: "#e8f5ee" },
    { value: "stay", label: "สวนบ้านนอก", sub: "โฮมสเตย์ / พักผ่อน", color: BRICK, bg: "#fdf0ea" },
    { value: "both", label: "ทั้งสอง", sub: "ใช้บริการทั้ง 2 ธุรกิจ", color: "#555", bg: "#f0f0f0" },
  ];

  const isOTA = detectedFormat === "agoda" || detectedFormat === "booking";
  const totalBookings = isOTA ? pendingRows.reduce((s, r) => s + (r.bookings?.length || 1), 0) : 0;
  const returnGuests  = isOTA ? pendingRows.filter(r => r.visits >= 2).length : 0;
  const totalRevenue  = detectedFormat === "booking"
    ? pendingRows.reduce((s, r) => s + (r.bookings || []).reduce((ss, b) => ss + (b.price || 0), 0), 0)
    : 0;

  const formatLabel = detectedFormat === "agoda" ? "Agoda" : detectedFormat === "booking" ? "Booking.com" : "";
  const formatColor = detectedFormat === "agoda" ? "#c0392b" : detectedFormat === "booking" ? "#1a56c4" : "#555";
  const formatBg    = detectedFormat === "agoda" ? "#fff5f5" : detectedFormat === "booking" ? "#f0f4ff" : "#f5f5f5";
  const formatBorder= detectedFormat === "agoda" ? "#f5c6c0" : detectedFormat === "booking" ? "#c0d0f5" : "#ddd";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 28, width: 500, maxWidth: "95vw" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#2a2a25", marginBottom: 4 }}>นำเข้าข้อมูล Excel</div>

        {isOTA ? (
          <div style={{ background: formatBg, border: `1px solid ${formatBorder}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 18 }}>{detectedFormat === "booking" ? "🏨" : "🏔️"}</span>
              <div style={{ fontSize: 13, fontWeight: 600, color: formatColor }}>ตรวจพบ {formatLabel} Format</div>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "#666" }}>👤 {pendingRows.length} ลูกค้า</span>
              <span style={{ fontSize: 12, color: "#666" }}>📋 {totalBookings} bookings</span>
              <span style={{ fontSize: 12, color: "#666" }}>🔄 กลับมาซ้ำ {returnGuests} คน</span>
              {totalRevenue > 0 && <span style={{ fontSize: 12, color: "#666" }}>💰 THB {totalRevenue.toLocaleString(undefined,{maximumFractionDigits:0})}</span>}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#999", marginBottom: 16 }}>พบข้อมูล <b style={{ color: "#3a3a35" }}>{pendingRows.length}</b> รายการ</div>
        )}

        {isOTA && returnGuests > 0 && (
          <div style={{ background: "#f8fffe", border: "0.5px solid #b8ddc8", borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: FOREST, marginBottom: 6 }}>🔄 ลูกค้าที่กลับมาซ้ำ</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {pendingRows.filter(r => r.visits >= 2).map((r, i) => (
                <span key={i} style={{ background: "#e8f5ee", color: FOREST, fontSize: 11, padding: "2px 8px", borderRadius: 20 }}>
                  {r.name} ({r.visits}×)
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10 }}>ประเภทธุรกิจของรายการเหล่านี้</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
          {bizOptions.map(opt => (
            <label key={opt.value} onClick={() => setBiz(opt.value)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `2px solid ${biz === opt.value ? opt.color : "#e0ddd8"}`, borderRadius: 10, cursor: "pointer", background: biz === opt.value ? opt.bg : "#fff", transition: "all 0.15s" }}>
              <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${biz === opt.value ? opt.color : "#ccc"}`, background: biz === opt.value ? opt.color : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {biz === opt.value && <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#fff" }} />}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: biz === opt.value ? opt.color : "#3a3a35" }}>{opt.label}</div>
                <div style={{ fontSize: 12, color: "#999" }}>{opt.sub}</div>
              </div>
            </label>
          ))}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10 }}>วิธีจัดการข้อมูลในระบบ</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {[{ v: true, label: "เพิ่มต่อจากเดิม", sub: "ข้อมูลเดิมยังคงอยู่" }, { v: false, label: "แทนที่ทั้งหมด", sub: "ลบข้อมูลเดิมทั้งหมด" }].map(opt => (
            <label key={String(opt.v)} onClick={() => setAppend(opt.v)} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, padding: "10px 14px", border: `2px solid ${append === opt.v ? FOREST : "#e0ddd8"}`, borderRadius: 10, cursor: "pointer", background: append === opt.v ? "#e8f5ee" : "#fff", transition: "all 0.15s" }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: append === opt.v ? FOREST : "#3a3a35" }}>{opt.label}</span>
              <span style={{ fontSize: 11, color: "#999" }}>{opt.sub}</span>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onCancel} style={{ background: "#fff", color: "#3a3a35", border: "0.5px solid #d0cdc8", padding: "9px 22px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>ยกเลิก</button>
          <button onClick={() => onConfirm(biz, append)} style={{ background: FOREST, color: "#fff", border: "none", padding: "9px 22px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit", fontWeight: 600 }}>
            Import {pendingRows.length} รายการ
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Booking History Panel ─────────────────────────────────────────────────────
function BookingHistory({ bookings }) {
  if (!bookings || bookings.length === 0) return <div style={{ fontSize: 12, color: "#bbb" }}>ไม่มีประวัติ</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {bookings.map((b, i) => (
        <div key={i} style={{ background: "#f8fffe", border: "0.5px solid #d0edd8", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 600, color: "#3a3a35" }}>{b.roomName || "-"}</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {b.price > 0 && <span style={{ color: FOREST, fontWeight: 600 }}>฿{b.price.toLocaleString(undefined,{maximumFractionDigits:0})}</span>}
              <span style={{ fontSize: 10, color: "#aaa" }}>#{b.bookingId}</span>
            </div>
          </div>
          <div style={{ color: "#777", marginTop: 2 }}>
            {b.checkIn || "?"} → {b.checkOut || "?"}
            {" · "}{b.guests} คน · {b.nights} คืน
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function CRM() {
  const [tab, setTab] = useState("dashboard");
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState("");
  const [bizFilter, setBizFilter] = useState("all");
  const [editCustomer, setEditCustomer] = useState(null);
  const [viewBookings, setViewBookings] = useState(null);
  const [insDateStart, setInsDateStart] = useState("");
  const [insDateEnd, setInsDateEnd] = useState("");
  const [pendingRows, setPendingRows] = useState(null);
  const [pendingFormat, setPendingFormat] = useState("standard");
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState("");
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState("");
  const fileRef = useRef();

  // ── Load from Supabase on mount ─────────────────────────────────────────────
  const loadCustomers = useCallback(async () => {
    setDbLoading(true);
    setDbError("");
    try {
      const { data: custData, error: custErr } = await supabase
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false });
      if (custErr) throw custErr;

      const { data: bookData, error: bookErr } = await supabase
        .from("bookings")
        .select("*");
      if (bookErr) throw bookErr;

      // attach bookings to customers
      const bookMap = {};
      (bookData || []).forEach(b => {
        if (!bookMap[b.customer_id]) bookMap[b.customer_id] = [];
        bookMap[b.customer_id].push({
          bookingId: b.booking_id,
          checkIn:   b.check_in,
          checkOut:  b.check_out,
          roomName:  b.room_name,
          guests:    b.guests,
          nights:    b.nights,
          price:     parseFloat(b.price) || 0,
          commission:parseFloat(b.commission) || 0,
        });
      });

      const mapped = (custData || []).map(c => ({
        id:          c.id,
        name:        c.name,
        tel:         c.tel || "",
        dob:         c.dob || "",
        age:         c.age || "",
        sex:         c.sex || "",
        idNum:       c.id_num || "",
        occ:         c.occ || "",
        bene:        c.bene || "",
        rel:         c.rel || "",
        address:     c.address || "",
        biz:         c.biz || "stay",
        status:      c.status || "Newbie",
        visits:      c.visits || 1,
        lastCheckIn: c.last_check_in || "",
        lastRoom:    c.last_room || "",
        source:      c.source || "manual",
        med:         c.med || "",
        note:        c.note || "",
        bookings:    bookMap[c.id] || [],
      }));
      setCustomers(mapped);
    } catch (err) {
      setDbError("โหลดข้อมูลไม่ได้: " + err.message);
    } finally {
      setDbLoading(false);
    }
  }, []);

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  // ── Save single customer + bookings to Supabase ─────────────────────────────
  async function upsertCustomer(c) {
    const row = {
      name: c.name, tel: c.tel, dob: c.dob,
      age: parseInt(c.age) || null, sex: c.sex, id_num: c.idNum,
      occ: c.occ, bene: c.bene, rel: c.rel, address: c.address,
      biz: c.biz, status: c.status, visits: c.visits,
      last_check_in: c.lastCheckIn || "", last_room: c.lastRoom || "",
      source: c.source || "manual", med: c.med, note: c.note,
    };
    if (c.id && typeof c.id === "number") row.id = c.id;

    const { data, error } = await supabase
      .from("customers")
      .upsert(row, { onConflict: "id" })
      .select()
      .single();
    if (error) throw error;

    // save bookings if any
    if (c.bookings && c.bookings.length > 0) {
      const bookRows = c.bookings.map(b => ({
        customer_id: data.id,
        booking_id:  b.bookingId || "",
        check_in:    b.checkIn || "",
        check_out:   b.checkOut || "",
        room_name:   b.roomName || "",
        guests:      b.guests || 1,
        nights:      b.nights || 1,
        price:       b.price || 0,
        commission:  b.commission || 0,
      }));
      // delete old bookings for this customer then re-insert
      await supabase.from("bookings").delete().eq("customer_id", data.id);
      await supabase.from("bookings").insert(bookRows);
    }
    return data.id;
  }


  const total = customers.length;
  const hikeCount = customers.filter(c => c.biz === "hike" || c.biz === "both").length;
  const stayCount = customers.filter(c => c.biz === "stay" || c.biz === "both").length;
  const legendCount = customers.filter(c => c.status === "Legend").length;
  const newbieCount = customers.filter(c => c.status === "Newbie").length;
  const regularCount = customers.filter(c => c.status === "Regular").length;
  const maleCount = customers.filter(c => c.sex === "ชาย").length;
  const femaleCount = customers.filter(c => c.sex === "หญิง").length;
  const maxBar = Math.max(newbieCount, regularCount, legendCount, 1);
  const crossSellCandidates = customers.filter(c => c.biz === "stay").slice(0, 6);
  const agodaCount = customers.filter(c => c.source === "agoda" || c.source === "booking").length;

  const filteredCustomers = useMemo(() => customers.filter(c => {
    const matchBiz = bizFilter === "all" ||
      (bizFilter === "hike" && (c.biz === "hike" || c.biz === "both")) ||
      (bizFilter === "stay" && (c.biz === "stay" || c.biz === "both"));
    const q = search.toLowerCase();
    const matchQ = !q || c.name.toLowerCase().includes(q) || (c.tel || "").includes(q);
    return matchBiz && matchQ;
  }), [customers, search, bizFilter]);

  const insuranceList = customers.filter(c => c.biz === "hike" || c.biz === "both");

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportError("");
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const wb = XLSX.read(evt.target.result, { type: "array", cellDates: false });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const { rows, format } = parseRows(sheet);
        if (rows.length === 0) {
          setImportError("ไม่พบข้อมูลในไฟล์ หรือ column headers ไม่ตรงกับรูปแบบที่รองรับ");
          return;
        }
        setPendingRows(rows);
        setPendingFormat(format);
      } catch (err) { setImportError("อ่านไฟล์ไม่ได้: " + err.message); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  }

  async function confirmImport(biz, append) {
    setPendingRows(null);
    setImportError("");
    const bizLabel = biz === "hike" ? "ดงดิบ" : biz === "stay" ? "สวนบ้านนอก" : "ทั้งสอง";
    const fmtLabel = pendingFormat === "agoda" ? " (Agoda)" : pendingFormat === "booking" ? " (Booking.com)" : "";

    try {
      if (!append) {
        // replace all: delete everything first
        await supabase.from("bookings").delete().neq("id", 0);
        await supabase.from("customers").delete().neq("id", 0);
      }

      // load current customers for merge lookup
      const { data: existing } = await supabase.from("customers").select("id, name, visits, source");
      const existingMap = {};
      (existing || []).forEach(e => { existingMap[e.name.toLowerCase()] = e; });

      for (const r of pendingRows) {
        const enriched = { ...r, biz, status: calcStatus(r.visits || 1) };
        const key = enriched.name.toLowerCase();

        if (append && existingMap[key]) {
          // merge: load existing bookings, union with new
          const existingId = existingMap[key].id;
          const { data: oldBookings } = await supabase.from("bookings").select("booking_id").eq("customer_id", existingId);
          const oldIds = new Set((oldBookings || []).map(b => b.booking_id));
          const newBookings = (enriched.bookings || []).filter(b => !oldIds.has(b.bookingId));
          const visits = Math.max(existingMap[key].visits || 1, (oldBookings?.length || 0) + newBookings.length || enriched.visits);

          await supabase.from("customers").update({
            visits, status: calcStatus(visits),
            last_check_in: enriched.lastCheckIn || "",
            last_room: enriched.lastRoom || "",
            source: existingMap[key].source === "agoda" || enriched.source === "agoda" ? "agoda" : enriched.source,
          }).eq("id", existingId);

          if (newBookings.length > 0) {
            await supabase.from("bookings").insert(newBookings.map(b => ({
              customer_id: existingId,
              booking_id: b.bookingId || "", check_in: b.checkIn || "",
              check_out: b.checkOut || "", room_name: b.roomName || "",
              guests: b.guests || 1, nights: b.nights || 1,
              price: b.price || 0, commission: b.commission || 0,
            })));
          }
        } else {
          await upsertCustomer(enriched);
        }
      }

      setImportSuccess(`Import สำเร็จ${fmtLabel} ${pendingRows.length} รายการ → ${bizLabel}`);
      setTimeout(() => setImportSuccess(""), 4000);
      await loadCustomers();
      setTab("customers");
    } catch (err) {
      setImportError("บันทึกข้อมูลไม่ได้: " + err.message);
    }
  }

  async function saveEdit(updated) {
    try {
      const toSave = { ...updated, status: calcStatus(updated.visits || 1) };
      await upsertCustomer(toSave);
      await loadCustomers();
      setEditCustomer(null);
    } catch (err) {
      setImportError("บันทึกไม่ได้: " + err.message);
    }
  }

  function exportCSV() {
    const rows = [
      ["ชื่อ-นามสกุล","เลขบัตรประชาชน","วันเกิด","ผู้รับผลประโยชน์","ความสัมพันธ์","เบอร์ติดต่อฉุกเฉิน"],
      ...insuranceList.map(c => [c.name, c.idNum, c.dob, c.bene, c.rel, c.tel])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v||"").replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff"+csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "insurance_list.csv"; a.click();
  }

  const iStyle = { padding:"8px 12px", border:"0.5px solid #d0cdc8", borderRadius:8, fontSize:14, fontFamily:"inherit", color:"#3a3a35", background:"#fff", width:"100%" };
  const card = { background:"#fff", border:"0.5px solid #e0ddd8", borderRadius:12, padding:18 };

  return (
    <div style={{ minHeight:"100vh", background:"#faf8f5", fontFamily:"'Sarabun','Noto Sans Thai',sans-serif" }}>

      {/* Topbar */}
      <div style={{ background:FOREST, padding:"0 20px", display:"flex", alignItems:"center", gap:12, height:56, position:"sticky", top:0, zIndex:100 }}>
        <div style={{ fontFamily:"Georgia,serif", fontSize:17, color:"#fff", fontWeight:700 }}>
          Dong<span style={{ color:"#7dd9a4" }}>Dib</span> <span style={{ color:"#f5c49a" }}>&</span> Suan
        </div>
        <div style={{ display:"flex", gap:4, flex:1, justifyContent:"center" }}>
          {[["dashboard","Dashboard"],["customers","ลูกค้า"],["insurance","ประกันภัย"]].map(([id,label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ background:tab===id?"rgba(255,255,255,0.2)":"transparent", border:"none", color:tab===id?"#fff":"rgba(255,255,255,0.7)", padding:"8px 16px", borderRadius:6, cursor:"pointer", fontSize:14, fontWeight:500, fontFamily:"inherit" }}>{label}</button>
          ))}
        </div>
        <button onClick={() => fileRef.current.click()} style={{ display:"flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.35)", color:"#fff", padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit", fontWeight:500 }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M4 6l4 4 4-4M2 12h12v2H2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Import Excel
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} style={{ display:"none" }} />
        <div style={{ fontSize:12, color:"rgba(255,255,255,0.5)" }}>{total} คน</div>
      </div>

      {importError && <div style={{ background:"#fdecea", borderBottom:"1px solid #f5c0bb", padding:"10px 20px", fontSize:13, color:"#a32d2d", display:"flex", justifyContent:"space-between" }}>{importError}<button onClick={() => setImportError("")} style={{ background:"none", border:"none", cursor:"pointer", color:"#a32d2d", fontSize:16 }}>×</button></div>}
      {dbError && <div style={{ background:"#fdecea", borderBottom:"1px solid #f5c0bb", padding:"10px 20px", fontSize:13, color:"#a32d2d", display:"flex", justifyContent:"space-between" }}>{dbError}<button onClick={loadCustomers} style={{ background:"none", border:"none", cursor:"pointer", color:"#a32d2d", fontSize:12, textDecoration:"underline" }}>ลองใหม่</button></div>}
      {importSuccess && <div style={{ background:"#e8f5ee", borderBottom:"1px solid #b8ddc8", padding:"10px 20px", fontSize:13, color:FOREST }}>{importSuccess}</div>}

      {dbLoading && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", padding:"60px 20px", gap:10 }}>
          <div style={{ width:20, height:20, border:`3px solid #e0ddd8`, borderTopColor:FOREST, borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
          <span style={{ fontSize:14, color:"#999" }}>กำลังโหลดข้อมูล...</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {!dbLoading && <div style={{ padding:20 }}>

        {/* Empty state */}
        {customers.length === 0 && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 20px", textAlign:"center" }}>
            <div style={{ width:72, height:72, background:"#e8f5ee", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:18 }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M6 28V8a2 2 0 012-2h12l6 6v16a2 2 0 01-2 2H8a2 2 0 01-2-2z" stroke={FOREST} strokeWidth="1.5"/><path d="M20 6v6h6M11 17h10M11 21h6" stroke={FOREST} strokeWidth="1.5" strokeLinecap="round"/></svg>
            </div>
            <div style={{ fontSize:18, fontWeight:700, color:"#3a3a35", marginBottom:8 }}>ยังไม่มีข้อมูลลูกค้า</div>
            <div style={{ fontSize:14, color:"#999", marginBottom:22, maxWidth:400, lineHeight:1.7 }}>
              รองรับ <b style={{ color:FOREST }}>Agoda Booking</b> และ <b style={{ color:"#3a3a35" }}>ฟอร์มลูกค้าทั่วไป</b><br/>
              กด Import Excel แล้วระบบจะตรวจ format อัตโนมัติ
            </div>
            <button onClick={() => fileRef.current.click()} style={{ background:FOREST, color:"#fff", border:"none", padding:"11px 28px", borderRadius:10, cursor:"pointer", fontSize:15, fontFamily:"inherit", fontWeight:600, display:"flex", alignItems:"center", gap:8 }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M4 6l4 4 4-4M2 12h12v2H2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              เลือกไฟล์ Excel
            </button>
            <div style={{ marginTop:16, fontSize:12, color:"#ccc" }}>รองรับ .xlsx .xls .csv — Agoda Export / ฟอร์มลูกค้า</div>
          </div>
        )}

        {/* Dashboard */}
        {tab === "dashboard" && customers.length > 0 && (
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:20 }}>
              {[
                { label:"ลูกค้าทั้งหมด", val:total, sub:`OTA ${agodaCount} คน`, accent:"#888" },
                { label:"สายลุย (ดงดิบ)", val:hikeCount, sub:"เดินป่า / ผจญภัย", accent:FOREST },
                { label:"สายชิลล์ (สวนบ้านนอก)", val:stayCount, sub:"โฮมสเตย์ / พักผ่อน", accent:BRICK },
                { label:"Legend Members", val:legendCount, sub:"5+ ครั้ง", accent:"#e6a500" },
              ].map((s,i) => (
                <div key={i} style={{ ...card, padding:0, overflow:"hidden", display:"flex" }}>
                  <div style={{ width:4, background:s.accent, flexShrink:0 }} />
                  <div style={{ padding:"14px 16px" }}>
                    <div style={{ fontSize:12, color:"#888", marginBottom:6, fontWeight:500 }}>{s.label}</div>
                    <div style={{ fontSize:30, fontWeight:700, color:"#3a3a35", lineHeight:1 }}>{s.val}</div>
                    <div style={{ fontSize:11, color:"#999", marginTop:4 }}>{s.sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
              <div style={card}>
                <div style={{ fontSize:14, fontWeight:600, color:"#3a3a35", marginBottom:14 }}>Member Status</div>
                {[{ label:"Newbie", count:newbieCount, color:"#aaa" },{ label:"Regular", count:regularCount, color:FOREST },{ label:"Legend ⭐", count:legendCount, color:"#e6a500" }].map((m,i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                    <div style={{ fontSize:13, width:80, color:"#3a3a35" }}>{m.label}</div>
                    <div style={{ flex:1, height:10, background:"#eee", borderRadius:5, overflow:"hidden" }}>
                      <div style={{ width:Math.round(m.count/maxBar*100)+"%", height:"100%", background:m.color, borderRadius:5 }} />
                    </div>
                    <div style={{ fontSize:13, color:"#888", width:24, textAlign:"right" }}>{m.count}</div>
                  </div>
                ))}
                <div style={{ marginTop:18, borderTop:"0.5px solid #f0ede8", paddingTop:14 }}>
                  <div style={{ fontSize:14, fontWeight:600, color:"#3a3a35", marginBottom:10 }}>สัดส่วนเพศ</div>
                  <div style={{ display:"flex", gap:10 }}>
                    <div style={{ flex:1, textAlign:"center", background:"#e8f5ee", borderRadius:8, padding:10 }}>
                      <div style={{ fontSize:24, fontWeight:700, color:FOREST }}>{maleCount}</div>
                      <div style={{ fontSize:12, color:FOREST }}>ชาย</div>
                    </div>
                    <div style={{ flex:1, textAlign:"center", background:"#fdf0ea", borderRadius:8, padding:10 }}>
                      <div style={{ fontSize:24, fontWeight:700, color:BRICK }}>{femaleCount}</div>
                      <div style={{ fontSize:12, color:BRICK }}>หญิง</div>
                    </div>
                  </div>
                </div>
              </div>
              <div style={card}>
                <div style={{ fontSize:14, fontWeight:600, color:"#3a3a35", marginBottom:4 }}>Cross-Sell Insights</div>
                <div style={{ fontSize:12, color:"#999", marginBottom:12 }}>ลูกค้าโฮมสเตย์ที่ควรชวนลองเดินป่า</div>
                {crossSellCandidates.length === 0 && <div style={{ fontSize:13, color:"#bbb", textAlign:"center", padding:"20px 0" }}>ยังไม่มีลูกค้าสายชิลล์</div>}
                {crossSellCandidates.map((c,i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0", borderBottom:i<crossSellCandidates.length-1?"0.5px solid #f0ede8":"none" }}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:500, color:"#3a3a35" }}>{c.name}</div>
                      <div style={{ fontSize:11, color:"#999" }}>
                        {c.source === "agoda" ? `จอง ${c.visits}× · ห้อง ${c.lastRoom || "-"}` : "สวนบ้านนอก → ชวนลองดงดิบ"}
                      </div>
                    </div>
                    <span style={{ fontSize:11, padding:"3px 10px", borderRadius:20, fontWeight:500, background:c.visits>=2?"#e8f5ee":"#fdf0ea", color:c.visits>=2?FOREST:BRICK }}>{c.visits>=2?"แนะนำสูง":"ลองชวน"}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Customers */}
        {tab === "customers" && customers.length > 0 && (
          <div>
            <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ค้นหาชื่อหรือเบอร์โทร..." style={{ ...iStyle, flex:1, minWidth:200 }} />
              <div style={{ display:"flex", gap:6 }}>
                {[["all","ทั้งหมด"],["hike","ดงดิบ"],["stay","สวนบ้านนอก"]].map(([f,label])=>{
                  const active = bizFilter===f;
                  const bg = active?(f==="stay"?BRICK:FOREST):"#fff";
                  return <button key={f} onClick={()=>setBizFilter(f)} style={{ padding:"8px 14px", border:`0.5px solid ${active?bg:"#d0cdc8"}`, borderRadius:8, background:bg, color:active?"#fff":"#3a3a35", cursor:"pointer", fontSize:13, fontFamily:"inherit", fontWeight:500 }}>{label}</button>;
                })}
              </div>
            </div>
            <div style={{ fontSize:12, color:"#999", marginBottom:8 }}>แสดง {filteredCustomers.length} จาก {total} รายการ</div>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", background:"#fff", borderRadius:12, overflow:"hidden", border:"0.5px solid #e0ddd8", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#f5f0e8" }}>
                    {["ชื่อ-สกุล","เบอร์โทร","อายุ/เพศ","เลขบัตร","ประเภท","Status","Visits / ห้อง","Note",""].map((h,i)=>(
                      <th key={i} style={{ padding:"10px 14px", textAlign:"left", fontWeight:600, fontSize:12, color:"#888", borderBottom:"0.5px solid #e0ddd8" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map(c=>(
                    <tr key={c.id} style={{ borderBottom:"0.5px solid #f5f2ee" }}>
                      <td style={{ padding:"11px 14px" }}>
                        <div style={{ fontWeight:500 }}>{c.name}</div>
                        <SourceBadge source={c.source} />
                      </td>
                      <td style={{ padding:"11px 14px" }}>{c.tel || "-"}</td>
                      <td style={{ padding:"11px 14px" }}>{c.age || "-"} / {c.sex || "-"}</td>
                      <td style={{ padding:"11px 14px", fontSize:11, color:"#999" }}>{c.idNum||"-"}</td>
                      <td style={{ padding:"11px 14px" }}><BizBadge biz={c.biz} /></td>
                      <td style={{ padding:"11px 14px" }}><StatusBadge status={c.status} /></td>
                      <td style={{ padding:"11px 14px" }}>
                        <div style={{ fontSize:13, fontWeight:600, color:"#3a3a35" }}>{c.visits}×</div>
                        {c.lastRoom && <div style={{ fontSize:11, color:"#999", marginTop:2 }}>{c.lastRoom}</div>}
                        {c.bookings && c.bookings.length > 0 && (
                          <button onClick={()=>setViewBookings(c)} style={{ background:"transparent", border:"none", color:FOREST, cursor:"pointer", fontSize:11, padding:0, marginTop:2, textDecoration:"underline", fontFamily:"inherit" }}>
                            ดูประวัติ ({c.bookings.length})
                          </button>
                        )}
                      </td>
                      <td style={{ padding:"11px 14px", fontSize:12, color:"#999", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.note||"-"}</td>
                      <td style={{ padding:"11px 14px" }}><button onClick={()=>setEditCustomer({...c})} style={{ background:"transparent", border:"0.5px solid #d0cdc8", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:12, color:"#3a3a35", fontFamily:"inherit" }}>แก้ไข</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Insurance */}
        {tab === "insurance" && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14, flexWrap:"wrap" }}>
              <span style={{ fontSize:13, color:"#888", fontWeight:500 }}>วันเดินทาง:</span>
              <input type="date" value={insDateStart} onChange={e=>setInsDateStart(e.target.value)} style={{ ...iStyle, width:"auto" }} />
              <span style={{ fontSize:13, color:"#888" }}>ถึง</span>
              <input type="date" value={insDateEnd} onChange={e=>setInsDateEnd(e.target.value)} style={{ ...iStyle, width:"auto" }} />
              <button onClick={exportCSV} disabled={insuranceList.length===0} style={{ marginLeft:"auto", background:insuranceList.length?FOREST:"#ccc", color:"#fff", border:"none", padding:"9px 20px", borderRadius:8, cursor:insuranceList.length?"pointer":"not-allowed", fontSize:14, fontFamily:"inherit", fontWeight:500 }}>Export CSV</button>
            </div>
            {insuranceList.length === 0 ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"#bbb", fontSize:14 }}>ยังไม่มีข้อมูล — กด Import Excel แล้วเลือกประเภท "ดงดิบ" หรือ "ทั้งสอง"</div>
            ) : (
              <>
                <div style={{ fontSize:13, color:"#888", marginBottom:10 }}>ลูกค้าสำหรับประกัน <b style={{ color:"#3a3a35" }}>{insuranceList.length}</b> คน</div>
                <table style={{ width:"100%", borderCollapse:"collapse", background:"#fff", borderRadius:12, overflow:"hidden", border:"0.5px solid #e0ddd8", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:"#e8f5ee" }}>
                      {["ชื่อ-นามสกุล","เลขบัตรประชาชน","วันเกิด","ผู้รับผลประโยชน์","ความสัมพันธ์","เบอร์ติดต่อฉุกเฉิน"].map((h,i)=>(
                        <th key={i} style={{ padding:"10px 14px", textAlign:"left", fontWeight:600, fontSize:12, color:FOREST, borderBottom:"0.5px solid #b8ddc8" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {insuranceList.map((c,i)=>(
                      <tr key={c.id} style={{ borderBottom:i<insuranceList.length-1?"0.5px solid #f5f2ee":"none" }}>
                        <td style={{ padding:"11px 14px", fontWeight:500 }}>{c.name}</td>
                        <td style={{ padding:"11px 14px", fontSize:12 }}>{c.idNum||"-"}</td>
                        <td style={{ padding:"11px 14px" }}>{c.dob||"-"}</td>
                        <td style={{ padding:"11px 14px" }}>{c.bene||"-"}</td>
                        <td style={{ padding:"11px 14px" }}>{c.rel||"-"}</td>
                        <td style={{ padding:"11px 14px" }}>{c.tel||"-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>

      {/* Import Modal */}
      {pendingRows && (
        <ImportModal
          pendingRows={pendingRows}
          detectedFormat={pendingFormat}
          onConfirm={confirmImport}
          onCancel={() => setPendingRows(null)}
        />
      )}

      {/* Booking History Modal */}
      {viewBookings && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ background:"#fff", borderRadius:14, padding:24, width:480, maxWidth:"95vw", maxHeight:"80vh", overflowY:"auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div>
                <div style={{ fontSize:16, fontWeight:600, color:"#3a3a35" }}>ประวัติการจอง</div>
                <div style={{ fontSize:13, color:"#999" }}>{viewBookings.name} · {viewBookings.visits} ครั้ง</div>
              </div>
              <button onClick={()=>setViewBookings(null)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:22, color:"#aaa" }}>×</button>
            </div>
            <BookingHistory bookings={viewBookings.bookings} />
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editCustomer && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ background:"#fff", borderRadius:14, padding:24, width:560, maxWidth:"95vw", maxHeight:"90vh", overflowY:"auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <div style={{ fontSize:17, fontWeight:600, color:"#3a3a35" }}>แก้ไข: {editCustomer.name}</div>
              <button onClick={()=>setEditCustomer(null)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:22, color:"#aaa" }}>×</button>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              {[{ label:"ชื่อ-นามสกุล", key:"name", full:true },{ label:"เบอร์โทร", key:"tel" },{ label:"เลขบัตรประชาชน", key:"idNum" },{ label:"วันเกิด", key:"dob", type:"date" },{ label:"อายุ", key:"age", type:"number" },{ label:"จำนวนครั้งที่เข้าใช้บริการ", key:"visits", type:"number" }].map(f=>(
                <div key={f.key} style={{ gridColumn:f.full?"1/-1":undefined, display:"flex", flexDirection:"column", gap:4 }}>
                  <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>{f.label}</label>
                  <input type={f.type||"text"} value={editCustomer[f.key]||""} onChange={e=>setEditCustomer(p=>({...p,[f.key]:e.target.value}))} style={iStyle} />
                </div>
              ))}
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>เพศ</label>
                <select value={editCustomer.sex||""} onChange={e=>setEditCustomer(p=>({...p,sex:e.target.value}))} style={iStyle}>
                  <option value="">-</option><option>ชาย</option><option>หญิง</option>
                </select>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>ผู้รับผลประโยชน์</label>
                <input value={editCustomer.bene||""} onChange={e=>setEditCustomer(p=>({...p,bene:e.target.value}))} style={iStyle} />
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>ความสัมพันธ์</label>
                <input value={editCustomer.rel||""} onChange={e=>setEditCustomer(p=>({...p,rel:e.target.value}))} style={iStyle} />
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>ประเภทธุรกิจ</label>
                <select value={editCustomer.biz} onChange={e=>setEditCustomer(p=>({...p,biz:e.target.value}))} style={iStyle}>
                  <option value="hike">ดงดิบ (เดินป่า)</option>
                  <option value="stay">สวนบ้านนอก (โฮมสเตย์)</option>
                  <option value="both">ทั้งสอง</option>
                </select>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>Member Status</label>
                <select value={editCustomer.status} onChange={e=>setEditCustomer(p=>({...p,status:e.target.value}))} style={iStyle}>
                  <option>Newbie</option><option>Regular</option><option>Legend</option>
                </select>
              </div>
              <div style={{ gridColumn:"1/-1", display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>โรคประจำตัว / แพ้</label>
                <input value={editCustomer.med||""} onChange={e=>setEditCustomer(p=>({...p,med:e.target.value}))} style={iStyle} />
              </div>
              <div style={{ gridColumn:"1/-1", display:"flex", flexDirection:"column", gap:4 }}>
                <label style={{ fontSize:12, color:"#888", fontWeight:500 }}>Preference Note</label>
                <textarea value={editCustomer.note||""} onChange={e=>setEditCustomer(p=>({...p,note:e.target.value}))} placeholder="เช่น ชอบกาแฟดริป, แพ้เกสรดอกไม้, ห้องพักชั้นล่าง" style={{ ...iStyle, resize:"vertical", minHeight:72 }} />
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"flex-end", gap:10, marginTop:16 }}>
              <button onClick={()=>setEditCustomer(null)} style={{ background:"#fff", color:"#3a3a35", border:"0.5px solid #d0cdc8", padding:"9px 22px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"inherit" }}>ยกเลิก</button>
              <button onClick={()=>saveEdit(editCustomer)} style={{ background:FOREST, color:"#fff", border:"none", padding:"9px 22px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"inherit", fontWeight:600 }}>บันทึก</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
