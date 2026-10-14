import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { androidReleaseReady, parseFlutterDoctorOutput } from "./flutter-doctor";
import { formatBuildReport } from "./engine";

const READY = `[√] Flutter (Channel stable, 3.27.1, on Microsoft Windows)
    • Flutter version 3.27.1 on channel stable at C:\\flutter
[√] Android toolchain - develop for Android devices (Android SDK version 35.0.0)
    • Android SDK at C:\\Users\\dev\\AppData\\Local\\Android\\sdk
    • All Android licenses accepted.
[X] Visual Studio - develop Windows apps
    X Visual Studio not installed; this is necessary to develop Windows apps.
[!] Chrome - develop for the web (Cannot find Chrome executable)`;

describe("flutter doctor parsing", () => {
  it("is ready when SDK and Android toolchain pass, whatever else is missing", () => {
    const checks = parseFlutterDoctorOutput(READY);
    assert.ok(androidReleaseReady(checks), JSON.stringify(checks));
  });

  it("is not ready when licenses are not accepted", () => {
    const out = READY.replace("All Android licenses accepted.", "Android license status unknown.");
    assert.equal(androidReleaseReady(parseFlutterDoctorOutput(out)), false);
  });

  it("is not ready when the output has no recognisable checks", () => {
    assert.equal(androidReleaseReady(parseFlutterDoctorOutput("Oops: flutter crashed")), false);
  });
});

describe("release build report", () => {
  it("surfaces Gradle's failure cause from the end of a long log", () => {
    const log = `${"> Task :app:compile\n".repeat(2000)}FAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':app:minifyReleaseWithR8'.\n> Missing class com.example.Foo\n\n* Try:\n> Run with --stacktrace`;
    const report = formatBuildReport({
      ok: false,
      target: "apk",
      command: "flutter build apk",
      artifactPath: "build/app.apk",
      artifactExists: false,
      output: log,
    });
    assert.match(report, /What went wrong \(from the Gradle log\):\n\* What went wrong:\nExecution failed for task ':app:minifyReleaseWithR8'/);
    assert.ok(report.length < 9000);
  });
});

