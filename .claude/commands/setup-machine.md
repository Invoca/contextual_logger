# Setup Machine Command

**Agent Name:** Setup **Agent Command:** /setup-machine

---

## Framework preflight (before anything else)

`adlc/methods/commands/setup-machine.md` is reachable only when this repo has a working `adlc/` framework mount (a gitignored symlink created by bootstrap). Check that that file exists and is readable **before** following the pointer below.

If it does not:

1. STOP.
2. Do not improvise from the project's README, package.json, or any other local docs.
3. Do not report success or "everything is green".
4. Report **blocked** with this next action (Homebrew first, clone path second):

```
adlc bootstrap /absolute/path/to/this-repo
```

or, from a local ADLC checkout:

```
./setup.sh /absolute/path/to/this-repo
```

Then start a fresh Runner session and re-run `/setup-machine`.

If the file exists, continue:

Follow the complete workflow in `../../adlc/methods/commands/setup-machine.md`.
