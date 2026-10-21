# Contributing to croquera-ifc-viewer

Thank you for your interest in contributing to **croquera-ifc-viewer**!

This project is open source under the **Apache-2.0 License**.

## Developer Certificate of Origin (DCO)

To ensure clear chain of custody and intellectual property compliance without burdensome legal paperwork, this project uses the **Developer Certificate of Origin (DCO)** version 1.1 (the same system used by the Linux kernel and Git projects).

By contributing, you certify the following:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### How to Sign Off Your Commits

Simply add a `Signed-off-by` trailer to your commit message:

```bash
git commit -s -m "feat(importer): add zero-copy streaming for large IFC files"
```

This will automatically append:

```
Signed-off-by: Jane Doe <jane.doe@example.com>
```

---

## Code Quality & Engineering Standards

1. **TypeScript Strictness:** Strict mode is enforced. No `any` casting where domain types can be used.
2. **Performance First:** All geometric operations must be evaluated with $O(1)$ allocations in hot loops and typed arrays (`Float32Array`, `Uint32Array`).
3. **Decoupled Architecture:** `@croquera/ifc-core` must remain 100% agnostic to UI frameworks, DOM, and rendering libraries.
