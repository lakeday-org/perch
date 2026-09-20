# Scanner example applications

These applications deliberately accept an order when one requested item is in
stock and another is unavailable. The Python application also contains the
other defects used in the public documentation. Keep the fixture defects in
source; apply corrections only to temporary copies.

| Application | Language | Availability check |
| --- | --- | --- |
| `order-service` | Python | `checkout.py::can_fulfil` |
| `order-service-typescript` | TypeScript | `src/inventory.ts::canFulfil` |
| `order-service-frontend` | TypeScript + React TSX | `src/CheckoutPanel.tsx::canCheckout` |
| `order-service-rust` | Rust | `src/inventory.rs::can_fulfil` |
| `order-service-java` | Java 17+ | `src/example/Inventory.java::Inventory.canFulfil` |
| `order-service-cpp` | C++17 | `src/checkout.cpp::can_fulfil` |

`npm test` parses all six applications and checks the buggy methods' names,
source spans and complexity. Each application must have zero parse failures.
The repository's `perch.yaml` excludes `test/fixtures/**` from ordinary scans.
The TypeScript apps have their own compiler settings and dependencies.

## Live CLI verification

With `PERCH_API_KEY` exported, run this from the repository root:

```sh
npm run test:fixtures
```

This makes real Jev requests. It creates six temporary git repositories and
checks scanning, cached rescans, method and issue-id checks, verbose diagnostics,
path and revision filters, issue inspection, close/reopen, rule add/edit/remove,
whole-file rules, doctor and Codex setup. It corrects the stock check without a
commit and requires both the method rule and the file rule to pass. It then
commits that correction and checks the changed-file scan.

The report and command output are saved under `.perch/fixture-verification/`.
The report names the temporary repositories so failures can be inspected.
The fixture source files are never changed by this command.

## Run an application

Run these commands inside the selected application's directory:

| Application | Commands |
| --- | --- |
| Python | `python3 main.py` |
| TypeScript | `npm install`, `npm run build`, `npm start` |
| React frontend | `npm install`, `npm run build`, `python3 -m http.server 8000` |
| Rust | `cargo run` |
| Java | `javac --release 17 -d out src/example/*.java`, `java -cp out example.Main` |
| C++ | `mkdir -p out`, `c++ -std=c++17 src/*.cpp -o out/orders`, `./out/orders` |

The frontend opens at `http://localhost:8000`. Its Place order button is enabled
despite the unavailable pens. The console applications likewise accept the
mixed-stock order. These outcomes are the defects the checks must identify.
