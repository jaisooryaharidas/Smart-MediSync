# Smart MediSync ID System (web)

Prescription photo → Google Gemini extraction → **you verify/edit** → medication schedule → reminders → history → adherence → caregiver view.

## Run locally
1. Install Node.js 20+ (22 recommended), then `npm install`
2. `cp .env.example .env` and set `GEMINI_API_KEY` (free, no card: https://aistudio.google.com/apikey) and `AUTH_SECRET` (any long random string)
3. `npm run dev` → open http://localhost:5173 (API runs on :4000)
4. Single-server mode: `npm start` → http://localhost:4000
5. Tests: `npm test` (schedule logic + API/access-control tests; no network or API key needed)

## Features
- Register / login / logout; every user only sees their own data
- Prescription upload (photo/camera) → Gemini → editable review screen (unreadable fields are highlighted as "Unknown") → confirm → schedule
- **Add Medicine Manually** (Dashboard → Medications): no Gemini key needed; uses the same save API and schedule logic as the prescription flow. Start date can be today or later.
- Dashboard: today's doses, upcoming, missed, adherence; mark taken, edit or remove medicines (editing regenerates only future doses)
- Dose status: **taken** (within 30 min), **taken late** (after 30 min), **missed** (not logged within 2 h; can still be logged as taken late)
- Adherence = (taken + late) / (taken + late + missed) × 100; History page with 7-day chart and filter
- Reminders: browser notifications (free, built in) plus an in-app banner
- Caregiver: a patient enters a registered user's email to grant **read-only** access (schedule, dose status, missed doses, adherence); patient can revoke any time

## Creating test data
- Without a Gemini key: Dashboard → Medications → **Add Medicine Manually** (e.g. Paracetamol, 1 tablet, "four times daily", start today, 3 days).
- With a key: Prescriptions → upload a sample prescription → review → confirm.
- Both paths create identical medication records and doses.

## Notes and limitations
- Reminders only fire while the app page is open in a browser tab (no paid push service). Some mobile browsers block the Notification API; the in-app banner still appears.
- Schedule generation, date grouping and dashboard display use the `Asia/Kolkata` time zone explicitly; they do not depend on Render's server timezone. Existing UTC-generated schedules are migrated once at server startup, with a pre-migration database backup retained as `db.json.pre-ist-migration`.
- Gemini key stays on the server (`server/index.js`); the browser never sees it. Data: `server/data/db.json`; images: `server/uploads/` (both git-ignored, no cloud storage).
- Free-tier Gemini requests may be used by Google to improve its products — use sample prescriptions for demos.
- Gemini model IDs change. If extraction fails, copy a current Flash model ID from AI Studio into `GEMINI_MODEL`.
- Optional IoT hardware from the synopsis is not part of this implementation.
- AI-extracted prescription information should be verified by the user/healthcare professional before use.
