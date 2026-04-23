# 🌿 DongDib & Suan CRM — คู่มือ Deploy

## ภาพรวม Stack
- **Frontend**: React + Vite
- **Database**: Supabase (PostgreSQL ฟรี 500MB)
- **Hosting**: Vercel (ฟรี)

---

## ขั้นตอนที่ 1 — ตั้งค่า Supabase (Database)

### 1.1 สร้าง Project
1. ไปที่ https://supabase.com → **Start your project**
2. สมัครด้วย GitHub
3. กด **New project** → ตั้งชื่อ `crm-dongdib-suan`
4. ตั้ง Database Password (จดไว้) → เลือก Region: **Southeast Asia (Singapore)**
5. รอประมาณ 1-2 นาทีจนสร้างเสร็จ

### 1.2 สร้างตาราง
1. ใน Supabase dashboard → คลิก **SQL Editor** (ไอคอนรูปฐานข้อมูล)
2. กด **New query**
3. เปิดไฟล์ `supabase-schema.sql` แล้ว copy ทั้งหมด วางในช่อง SQL
4. กด **Run** (Ctrl+Enter) — ควรเห็น "Success"

### 1.3 เก็บ Credentials
1. ไปที่ **Settings** (ฟันเฟือง) → **API**
2. คัดลอก 2 ค่านี้ไว้:
   - **Project URL** → `https://xxxxxxxxxxxx.supabase.co`
   - **anon public** key → `eyJhbGciOi...`

---

## ขั้นตอนที่ 2 — ตั้งค่า GitHub

### 2.1 สร้าง Repository
1. ไปที่ https://github.com → **New repository**
2. ตั้งชื่อ `crm-dongdib-suan` → **Private** → **Create**

### 2.2 Push โค้ด
เปิด Terminal แล้วรันคำสั่งเหล่านี้:

```bash
# เข้าโฟลเดอร์โปรเจกต์
cd crm-project

# สร้างไฟล์ .env จาก template
cp .env.example .env

# แก้ไข .env ใส่ค่าจาก Supabase
# VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
# VITE_SUPABASE_ANON_KEY=eyJhbGciOi...

# Init git และ push
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/crm-dongdib-suan.git
git push -u origin main
```

> ⚠️ ไฟล์ `.env` อยู่ใน `.gitignore` แล้ว — ค่า secret จะไม่ถูก push ขึ้น GitHub

---

## ขั้นตอนที่ 3 — Deploy บน Vercel

### 3.1 เชื่อม Vercel กับ GitHub
1. ไปที่ https://vercel.com → **Sign up with GitHub**
2. กด **Add New Project**
3. เลือก repository `crm-dongdib-suan`
4. **Framework Preset**: เลือก **Vite**
5. **อย่ากด Deploy ก่อน** — ต้องใส่ Environment Variables ก่อน

### 3.2 ใส่ Environment Variables
ใน Vercel project settings ก่อน deploy:
1. เลื่อนลงหา **Environment Variables**
2. เพิ่ม 2 ค่า:

| Name | Value |
|------|-------|
| `VITE_SUPABASE_URL` | `https://xxxxxxxxxxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOi...` |

3. กด **Deploy** ✅

### 3.3 รอ Build เสร็จ
- Vercel จะ build ประมาณ 1-2 นาที
- เมื่อเสร็จจะได้ URL เช่น `https://crm-dongdib-suan.vercel.app`

---

## ขั้นตอนที่ 4 — ทดสอบ

1. เปิด URL ที่ได้จาก Vercel
2. กด **Import Excel** → ลอง import ไฟล์ Agoda หรือ Booking.com
3. รีเฟรชหน้า — ข้อมูลควรยังอยู่ (บันทึกใน Supabase แล้ว)

---

## การ Deploy ครั้งถัดไป (Auto Deploy)

หลังจากนี้ทุกครั้งที่ push โค้ดใหม่ขึ้น GitHub:
```bash
git add .
git commit -m "update feature"
git push
```
Vercel จะ deploy ให้อัตโนมัติภายใน 1-2 นาที

---

## ค่าใช้จ่าย

| Service | Plan | ราคา |
|---------|------|------|
| Vercel | Hobby | **ฟรี** (100GB bandwidth/เดือน) |
| Supabase | Free | **ฟรี** (500MB DB, 50,000 rows) |

สำหรับ CRM ลูกค้าโฮมสเตย์ขนาดนี้ **ฟรีทั้งหมด** ครับ
ถ้าข้อมูลใหญ่มากขึ้นค่อยอัปเกรด Supabase Pro ($25/เดือน)

---

## โครงสร้างไฟล์

```
crm-project/
├── index.html              ← entry point
├── vite.config.js          ← Vite config
├── vercel.json             ← Vercel routing
├── package.json            ← dependencies
├── .env.example            ← template สำหรับ .env
├── .gitignore
├── supabase-schema.sql     ← รัน SQL นี้ใน Supabase ครั้งแรก
└── src/
    ├── main.jsx            ← React entry
    ├── App.jsx             ← CRM หลัก
    └── supabaseClient.js   ← Supabase connection
```
