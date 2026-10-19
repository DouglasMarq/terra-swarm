## Rules

- Name numbers as constants instead of using magic numbers (`const MAX_RETRIES = 3`). Expected values in test assertions may stay literal (`expect(response.status).toBe(402)`).
- Put generic, domain-free helpers (`formatDate`, `chunk`) in the project's existing shared folder (`utils/`, `helpers/`, `shared/` or whatever the codebase uses). Business logic never goes there.
- Before writing new code, search the codebase for code that already does it and reuse it. If business logic is buried inside another class (a private method, an internal function), extract it into a service in the feature that owns that domain (installments → `payments/`) and import that service — never copy it. When no feature owns it, ask. A feature's public services are imported as usual. Extracting it is part of the task, not an unrequested refactor. Move it as-is — the rules and coverage apply only to lines whose content you change.
- Write small, simple functions that do one thing — when a function does more than one thing, split it. Extracting a named function is not an abstraction; an interface, abstract class or factory is, and is added only where more variants are known to be coming (see `architecture.md`).
- Handle edge cases first with early returns instead of nesting conditionals.
- Functions take at most three parameters (constructors and Go's `ctx` don't count). When more values belong together, group them into one object (TS type, Go struct, Java record). Never group unrelated values just to meet the limit — that means the function does too much; split it.
- A function either returns a value or changes state, never both — except where atomicity requires it (`pop`, a write that returns what it wrote: an insert returning its id, an update returning the row).
- Prefix boolean names with `is`, `has`, `can` or `should` (`isActive`, `hasItems`, `canEdit`; `IsActive` when exported in Go).
- Prefer the simplest solution that works — no abstractions, indirection or configurability the task does not need.

## Anti-patterns

- NEVER suppress compiler, type-checker or linter errors (`@ts-ignore`, `//nolint`, `@SuppressWarnings`, etc.) without a comment explaining why — fix the cause instead.
- NEVER use untyped values or unchecked casts (TS `any`, `as unknown as T`, non-null `!`; Go unchecked type assertions `x.(T)`; Java raw types and unchecked casts) without a comment explaining why — use precise types, or narrow unknown values with a check (TS type guards, Go `value, ok := x.(T)`, Java `instanceof`); the type-checker runs in its strictest mode (TS `"strict": true`).
- NEVER leave commented-out code or debug output in committed code.
- NEVER subclass only to reuse code — compose instead (pass the dependency in). Inheritance is for real "is-a" relationships (`class OrderNotFoundError extends DomainError`).
- NEVER write comments in code — the code explains itself through names and small functions. Only exceptions: comments the language or tooling requires (e.g. Go `//go:build`, `//go:embed`) and the justification for a suppression or cast (see above).
- NEVER use single-letter variable or parameter names like `i`, `j` or `k`, including loop counters — iterate over the items (`for (const order of orders)`, `for _, order := range orders`, `for (Order order : orders)`), or give the index a descriptive name (`rowIndex`) when it is needed. Idiomatic short names are allowed: type parameters (`<T>`, `<K, V>`), Go receivers (`func (o *Order)`) and Go's `w`/`r` in HTTP handlers.
