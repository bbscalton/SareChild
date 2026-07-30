@echo off
REM Run this AFTER: firebase login --reauth (with your SafeChild Google account)
cd /d "%~dp0"
echo Linking project safechild-f34ac...
firebase use safechild-f34ac
echo.
echo Deploying Firestore rules...
firebase deploy --only firestore:rules
echo.
echo Deploying Cloud Functions (requires Blaze plan)...
cd functions
call npm install
call npm run build
cd ..
firebase deploy --only functions
echo.
echo Done. Also enable in Firebase Console:
echo  - Authentication: Email/Password + Anonymous
echo  - Firestore: create database if not done
echo  - Add child app com.sarechild.child and download google-services.json
pause
