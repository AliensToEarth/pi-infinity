# Agent guidelines

Rules for people and for agents working in this repo. They follow the AGENTS.md of the
Infinity project.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <short summary>

<markdown body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`. The scope is the
module name (`jobs`, `timers`, `threads`, `sandbox`, `spec`). Mark breaking changes with `!`
after the type and a `BREAKING CHANGE:` footer.

Write the body in Markdown. Use bullets and code spans when a change touches several things.

```
feat(sandbox): add a jj backend

* Create one jj workspace and bookmark per thread
* Record squashed branches in `.squashed.json`
```

## Development

* Run `./check.bash` before finalizing. It is the only gate: format, typecheck, tests.
* If formatting fails, run `npm run fmt`. Do not edit formatting by hand.
* Never ignore errors. Pass them along, return them as a value, or call `logger.error`.
  An empty `catch` block fails the test suite.
* Use `throw new Error("bug: ...")` for states that can only happen through a logic bug.
  Runtime failures (bad input, missing file, dead process) get a plain message.
* `lib/` modules never import pi at runtime. Inject the clock, spawner and emitter.
* Change behavior in `SPEC.md` first, then in code. Requirement ids (R-xx) in the spec
  should be traceable to a test name.

## Layout

See section 3 of `SPEC.md`.
