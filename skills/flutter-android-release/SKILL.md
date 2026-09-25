---
name: flutter-android-release
description: Human setup checklist and agent workflow for Flutter Android APK/AAB builds. Load when the user asks for APK, AAB, Play Store release, or android/app signing — or when release_doctor reports blockers.
---

# Flutter Android release

Use **Lane D** tools: `release_doctor`, `release_build`, `/release doctor`, `/release build apk`.

## Agent workflow

1. `release_doctor` — if **not ready**, stop and give the human the blocker list.
2. Do **not** grep minified JS, edit Gradle repeatedly, or loop builds while doctor is red.
3. When **ready** → `release_build` with `target: "apk"` (or `appbundle`).
4. Success = exit 0 + artifact path from config (default `build/app/outputs/flutter-apk/app-release.apk`).

## Human one-time setup (Windows)

1. **Android Studio** — install with Standard SDK setup.
2. **SDK path** — after first Studio launch, SDK is usually at:
   `%LOCALAPPDATA%\Android\Sdk`
3. **Command-line Tools** — Android Studio → SDK Manager → SDK Tools →
   **Android SDK Command-line Tools (latest)** (required for licenses).
4. **Point Flutter at SDK:**
   ```powershell
   flutter config --android-sdk "$env:LOCALAPPDATA\Android\Sdk"
   ```
5. **Licenses** (interactive — human presses y):
   ```powershell
   flutter doctor --android-licenses
   ```
6. **Verify:**
   ```powershell
   flutter doctor -v
   ```
   Need: `[√] Android toolchain` and licenses accepted.

If `flutter` is not on PATH, set in `.pi/release.config.json`:

```json
"flutterCommand": "C:\\flutter\\bin\\flutter.bat"
```

Or set env `FLUTTER_ROOT`.

## Signing (before Play Store)

- Debug APKs work without custom signing.
- Release Play Store needs a keystore — store under `.pi/signing/` (gitignored).
- Wire `android/key.properties` + `android/app/build.gradle` — human creates keystore once.
- Never commit keystore passwords or `.jks` files.

## Pi config

Copy `release.config.example.json` from pi-client to `.pi/release.config.json` and adjust
`flutterCommand`, artifact paths, or signing paths if non-standard.

## Anti-patterns

- Long generic install essays without running `release_doctor`.
- Building while SDK/licenses are missing.
- Using Playwright scenarios to prove APK build success.
- Putting `flutter build apk` in verify-on-edit.
