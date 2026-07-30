# SareChild Parent Web

Browser dashboard for parents. Uses the same Firebase project and Firestore data as the Android parent app.

## Features

- Email/password sign-in and sign-up
- Live device status (online, battery, permissions, location)
- Alerts feed with mark-as-read
- Geofence create/delete at child’s last known location
- Pairing code generation for the child Android app

## Setup

1. Copy `.env.example` to `.env` (already configured for `safechild-f34ac` in this repo’s local `.env`).
2. Install and run:

```bash
cd parent-web
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Deploy to Firebase Hosting

```bash
cd parent-web
npm run build
cd ..
firebase deploy --only hosting --project safechild-f34ac
```

## Notes

- Use the **same parent account** as the Android parent app.
- Child monitoring still runs only on the Android child app.
- Enable **Email/Password** auth in Firebase Console.
- Enable **Anonymous** auth for the child app pairing flow.
