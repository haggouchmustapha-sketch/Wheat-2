# Wheat local update feed

`npm run update:package -- --notes-file <release-notes.md>` generates this feed. Do not hand-edit checksums or release metadata.

The generated layout is:

```text
updates/
  latest.json
  <semver>/
    WheatSetup-<semver>.exe
    release.json
```

Development builds read this directory but never execute installers. On Windows, the packaging command also publishes the same release to `%APPDATA%\Atlas Ledger\updates`, which is the packaged application's local feed.
