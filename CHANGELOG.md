# Changelog

## [0.3.6](https://github.com/lakeday-org/perch/compare/v0.3.5...v0.3.6) (2026-09-25)


### Features

* cloud scans report their results, and GitHub Actions signs in without a secret ([#157](https://github.com/lakeday-org/perch/issues/157)) ([ffd6d94](https://github.com/lakeday-org/perch/commit/ffd6d9406f724339a1df9aab71e6e19e0c7089cb))
* sign into Perch Cloud from the CLI ([#142](https://github.com/lakeday-org/perch/issues/142)) ([acf0df1](https://github.com/lakeday-org/perch/commit/acf0df146ed814da31aa4d57ea2d36808178a03f))


### Bug Fixes

* perch issues &lt;id&gt; printed documented NaN% on a default scan ([#165](https://github.com/lakeday-org/perch/issues/165)) ([b50eb63](https://github.com/lakeday-org/perch/commit/b50eb6365fee3fc94ae2b761b558dce0f86d8f08))


### Reverts

* Perch Cloud login and results upload in the CLI ([#168](https://github.com/lakeday-org/perch/issues/168)) ([5cb8840](https://github.com/lakeday-org/perch/commit/5cb8840137e79b44cdb46ba811dd9bcaa136cae1))

## [0.3.5](https://github.com/lakeday-org/perch/compare/v0.3.4...v0.3.5) (2026-09-24)


### Bug Fixes

* a method whose neighbourhood did not fit the budget was never read ([#103](https://github.com/lakeday-org/perch/issues/103)) ([182b5a4](https://github.com/lakeday-org/perch/commit/182b5a4308bf715efa740934f878090b72f29776))
* a reading over the request allowance was sent partway before being dropped ([#104](https://github.com/lakeday-org/perch/issues/104)) ([5754679](https://github.com/lakeday-org/perch/commit/5754679b00f88a4e1afb36f8b89fb825cafd9653))
* a request could carry more questions than the gateway accepts ([#121](https://github.com/lakeday-org/perch/issues/121)) ([6a399b7](https://github.com/lakeday-org/perch/commit/6a399b735b7aca43a6db9bffa679d8adbf7b28b4))
* a scan target reached through a symlink read no methods ([#146](https://github.com/lakeday-org/perch/issues/146)) ([69b519d](https://github.com/lakeday-org/perch/commit/69b519d903e5528ca32557fce61d0e2e7d90ced6))
* a scan with no API credits reported nothing to report and exited 0 ([#145](https://github.com/lakeday-org/perch/issues/145)) ([a6c5960](https://github.com/lakeday-org/perch/commit/a6c5960fbf5fc0d481df0dc9e6f55e5d6db929c3))
* a scan with only method rules still read every file's source ([#148](https://github.com/lakeday-org/perch/issues/148)) ([05b46d6](https://github.com/lakeday-org/perch/commit/05b46d6893010d3b997e8b0671d822114ed63af8))
* a syntax error anywhere in a file dropped every method in it ([#140](https://github.com/lakeday-org/perch/issues/140)) ([f0acade](https://github.com/lakeday-org/perch/commit/f0acade2d67b2faebfc601149a477403644e7afc))
* Improve large document scanning ([#102](https://github.com/lakeday-org/perch/issues/102)) ([5500d69](https://github.com/lakeday-org/perch/commit/5500d696a0930ad89f79bfc8f000eed68f5aea38))
* large scans repeatedly rewrote every previous answer ([#116](https://github.com/lakeday-org/perch/issues/116)) ([37822e3](https://github.com/lakeday-org/perch/commit/37822e310b99ba7c2395ecf74481a795dd61c29c))
* perch rules could not add to, edit or remove from a split rule file ([#100](https://github.com/lakeday-org/perch/issues/100)) ([9a2dbd8](https://github.com/lakeday-org/perch/commit/9a2dbd806a157e8e4b66b016913fe1aad56ca00b))
* question batches were capped at 128 when System One limits tokens ([#152](https://github.com/lakeday-org/perch/issues/152)) ([014fc18](https://github.com/lakeday-org/perch/commit/014fc18cab0073207544778ec960b5fb155002d6))
* reference extraction rejected non-ASCII names and misread TypeScript imports ([#147](https://github.com/lakeday-org/perch/issues/147)) ([9e0d66c](https://github.com/lakeday-org/perch/commit/9e0d66cd35bc08da1a816231826cf00dc632f6e5))
* unqualified Go calls searched every file in the repository ([#127](https://github.com/lakeday-org/perch/issues/127)) ([159dbec](https://github.com/lakeday-org/perch/commit/159dbec8a52cb5cf0ffc9e70f30d0e56b45c7f2e))


### Performance Improvements

* the node wrapper called into native code on every property read ([#105](https://github.com/lakeday-org/perch/issues/105)) ([50df913](https://github.com/lakeday-org/perch/commit/50df913752eba33d2e1f1648228c947766b0c944))

## [0.3.4](https://github.com/lakeday-org/perch/compare/v0.3.3...v0.3.4) (2026-09-21)


### Features

* scan_types decides which issue types a scan asks about ([#62](https://github.com/lakeday-org/perch/issues/62)) ([27868d0](https://github.com/lakeday-org/perch/commit/27868d0b1a7c0abb9626aaedb78f2a86f820f100))


### Bug Fixes

* a scan could hang, crash, or pass on an unread file ([#93](https://github.com/lakeday-org/perch/issues/93)) ([06d577b](https://github.com/lakeday-org/perch/commit/06d577baea50332831205a67bb4a6d2fe0f02448))
* allow custom API endpoints and models ([ba775a9](https://github.com/lakeday-org/perch/commit/ba775a9940b63c162679964b29f84b8ca8e54d59))
* dependency and build directories were entering scans across languages ([#92](https://github.com/lakeday-org/perch/issues/92)) ([b4ad713](https://github.com/lakeday-org/perch/commit/b4ad7138cbba00bf28a06ededf81f09519f10301))
* file rules skip the files method scanning excludes ([#88](https://github.com/lakeday-org/perch/issues/88)) ([77aee23](https://github.com/lakeday-org/perch/commit/77aee23dc0f2ea32e9b4718574da44696da88926))
* large files were skipped or exceeded Jev's request limits ([#89](https://github.com/lakeday-org/perch/issues/89)) ([aa3f08c](https://github.com/lakeday-org/perch/commit/aa3f08cac7060affab55e7c8d387897337560c0e))
* minified JavaScript variants stay out of scans ([#82](https://github.com/lakeday-org/perch/issues/82)) ([2d2fded](https://github.com/lakeday-org/perch/commit/2d2fdeda9a56a48674fdf8ba2df7b06490e18248))
* write .perch/.gitignore instead of editing .git/info/exclude ([#76](https://github.com/lakeday-org/perch/issues/76)) ([f494ffe](https://github.com/lakeday-org/perch/commit/f494ffe3218dbbbdd317470b1843d7b611fb86ef))

## [0.3.3](https://github.com/lakeday-org/perch/compare/v0.3.2...v0.3.3) (2026-09-19)


### Bug Fixes

* a release published from the branch could not tell it was one ([#59](https://github.com/lakeday-org/perch/issues/59)) ([d1db70b](https://github.com/lakeday-org/perch/commit/d1db70bd7e7c5a5f3357d3e0631b1fa5072baf6d))

## [0.3.2](https://github.com/lakeday-org/perch/compare/v0.3.0...v0.3.2) (2026-09-18)


### Features

* perch scan --filter rule=&lt;name&gt; runs one rule ([#56](https://github.com/lakeday-org/perch/issues/56)) ([2802d1e](https://github.com/lakeday-org/perch/commit/2802d1ea0cf9b9e8027f974e60eff0dcc51f92be))


### Bug Fixes

* a broken search rule was reported nowhere and failed nothing ([#55](https://github.com/lakeday-org/perch/issues/55)) ([9c3bfa6](https://github.com/lakeday-org/perch/commit/9c3bfa612625089a83fd7c479c6cd0b6ab8b1b93))
* perch scan &lt;dir&gt; read the whole repository ([#48](https://github.com/lakeday-org/perch/issues/48)) ([1628250](https://github.com/lakeday-org/perch/commit/162825039c86b79b6c8697e4428929f927cbb1b3))
* release-please tagged a form nothing publishes on ([#41](https://github.com/lakeday-org/perch/issues/41)) ([b037c17](https://github.com/lakeday-org/perch/commit/b037c17344db8592954b71603cb1bd4b60e57559))


### Miscellaneous Chores

* keep 0.x versions on patch bumps ([#57](https://github.com/lakeday-org/perch/issues/57)) ([a3b4929](https://github.com/lakeday-org/perch/commit/a3b49296ef0f080e46c5f743119a25a7194b924c))

## [0.3.0](https://github.com/lakeday-org/perch/compare/perch-v0.2.3...perch-v0.3.0) (2026-09-18)


### Features

* let release-please decide the version ([#37](https://github.com/lakeday-org/perch/issues/37)) ([221ab9a](https://github.com/lakeday-org/perch/commit/221ab9a6ad007c3ae6cbf7cbbe4751008139f53d))
* perch.yaml can say what not to read ([#40](https://github.com/lakeday-org/perch/issues/40)) ([3c5d842](https://github.com/lakeday-org/perch/commit/3c5d842daf5db9935a897c89582f941da2adfde4))


### Bug Fixes

* report a defect whose line was never located ([#39](https://github.com/lakeday-org/perch/issues/39)) ([77e7eba](https://github.com/lakeday-org/perch/commit/77e7eba76534478ea146578eb189d9f1fc41760a))
* the corrected method alone, checked by reachability, metrics, the tests that reach it, and System One ([80d1067](https://github.com/lakeday-org/perch/commit/80d1067e364c33fd72a2f04f74b2c5c8b008273a))
