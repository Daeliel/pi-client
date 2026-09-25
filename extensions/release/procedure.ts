/**
 * Lane D — Release builds (APK/AAB). Injected when the project has pubspec.yaml + android/.
 */
export const RELEASE_PROCEDURE = `
## Lane D — Release (Flutter Android APK/AAB)

Use this lane when the user asks for an APK, AAB, Play Store build, or "build for Android".
This is **not** verify-on-edit and **not** Playwright scenarios.

| | **Release (Lane D)** | **Scenarios (Lane A)** | **Verify** |
|--|---------------------|------------------------|------------|
| **Job** | Produce installable artifact | Prove UI flows in browser | Lint/typecheck/tests on edits |
| **Tools** | release_doctor, release_build | run_scenarios, define_scenarios | verify |
| **When** | User asks for APK/AAB | User-visible behaviour | After code edits |

### Workflow — build an APK

1. **release_doctor** (or \`/release doctor\`) — must be **ready** before claiming the toolchain works.
2. If doctor is **not ready** → stop. Tell the human what's missing (SDK, cmdline-tools, licenses). Pi cannot install Android Studio.
3. When doctor is **ready** → **release_build** with \`target: "apk"\` (or \`appbundle\` for Play Store).
4. Proof of success = command exit 0 **and** artifact file exists at the configured path (see release.config.json).
5. Do **not** grep minified JS or loop Gradle/signing changes while doctor is red.

### Human-only (one-time per PC)

- Install Android Studio + Android SDK + Command-line Tools
- \`flutter config --android-sdk\` (path to SDK)
- \`flutter doctor --android-licenses\`
- Keystore / signing: local files under \`.pi/signing/\` or \`android/key.properties\` — never commit secrets

### Config

- Defaults: \`.pi/release.config.json\` (optional) — commands, artifact paths, flutterCommand if not on PATH
- Example in pi-client: \`release.config.example.json\`

### Commands

- \`/release doctor\` — toolchain + project checks
- \`/release build apk\` — build release APK
- \`/release build appbundle\` — build Play Store AAB

Load skill **flutter-android-release** for the full human setup checklist when doctor fails.
`.trim();
