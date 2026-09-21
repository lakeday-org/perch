# Changelog

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
