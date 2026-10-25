## Rules

- Name numbers as constants instead of using magic numbers (`const MAX_RETRIES = 3`). Expected values in test assertions may stay literal (`expect(response.status).toBe(402)`).
- Put generic, domain-free helpers (`formatDate`, `chunk`) in the project's existing shared folder (`utils/`, `helpers/`, `shared/` or whatever the codebase uses). Business logic never goes there.
- Before writing new code, search the codebase for code that already does it and reuse it. If business logic is buried inside another class (a private method, an internal function), extract it into a service in the feature that owns that domain (installments → `payments/`) and import that service — never copy it. When no feature owns it, ask. A feature's public services are imported as usual. Extracting it is part of the task, not an unrequested refactor. Move it as-is — the rules and coverage apply only to lines whose content you change.
- Write small, simple functions that do one thing — when a function does more than one thing, split it. Extracting a named function is not an abstraction; an interface, abstract class or factory is, and is added only where more variants are known to be coming (see `architecture.md`).
- Handle edge cases first with early returns instead of nesting conditionals.
- Functions take at most three parameters (constructors, Rust's `new` and Go's `ctx` don't count). When more values belong together, group them into one object (TS type, Go struct, Rust struct, Java record). Never group unrelated values just to meet the limit — that means the function does too much; split it.
- A function either returns a value or changes state, never both — except where atomicity requires it (`pop`, a write that returns what it wrote: an insert returning its id, an update returning the row).
- Prefix boolean names with `is`, `has`, `can` or `should` (`isActive`, `hasItems`, `canEdit`; `IsActive` when exported in Go; `is_active` in Rust).
- Prefer the simplest solution that works — no abstractions, indirection or configurability the task does not need.

## Anti-patterns

- NEVER suppress compiler, type-checker or linter errors (`@ts-ignore`, `//nolint`, `@SuppressWarnings`, Rust `#[allow(...)]`, etc.) without a comment explaining why — fix the cause instead.
- NEVER use untyped values or unchecked casts (TS `any`, `as unknown as T`, non-null `!`; Go unchecked type assertions `x.(T)`; Rust lossy `as` casts; Java raw types and unchecked casts) without a comment explaining why — use precise types, or narrow unknown values with a check (TS type guards, Go `value, ok := x.(T)`, Rust `TryFrom`/`try_into`, Java `instanceof`); the type-checker runs in its strictest mode (TS `"strict": true`).
- NEVER call `unwrap()` or `expect()` outside tests in Rust — propagate the error with `?` or handle it. `expect` is allowed only for an invariant the code guarantees, with that invariant stated in its message.
- NEVER write an `unsafe` block in Rust without a `// SAFETY:` comment explaining why it is sound.
- NEVER leave commented-out code or debug output in committed code.
- NEVER subclass only to reuse code — compose instead (pass the dependency in). Inheritance is for real "is-a" relationships (`class OrderNotFoundError extends DomainError`).
- NEVER write comments in code, including Rust doc comments (`///`, `//!`) — the code explains itself through names and small functions. Only exceptions: comments the language or tooling requires (e.g. Go `//go:build`, `//go:embed`), the justification for a suppression or cast (see above) and Rust's `// SAFETY:` comment on `unsafe`.
- NEVER use single-letter variable or parameter names like `i`, `j` or `k`, including loop counters and closure parameters — iterate over the items (`for (const order of orders)`, `for _, order := range orders`, `for order in &orders`, `for (Order order : orders)`), or give the index a descriptive name (`rowIndex`) when it is needed. Idiomatic short names are allowed: type parameters (`<T>`, `<K, V>`), Go receivers (`func (o *Order)`) and Go's `w`/`r` in HTTP handlers.
