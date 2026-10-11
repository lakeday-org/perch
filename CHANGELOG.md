# Changelog

## [0.4.3](https://github.com/lakeday-org/perch/compare/v0.4.2...v0.4.3) (2026-10-11)


### Features

* perch ci shows what CI found on your branch ([#252](https://github.com/lakeday-org/perch/issues/252)) ([6f40a1f](https://github.com/lakeday-org/perch/commit/6f40a1f06b9990f83abfdc1e867c020cf64a3c31))


### Bug Fixes

* perch scan stopped on a function inside a constructor that uses this ([#359](https://github.com/lakeday-org/perch/issues/359)) ([dacd98f](https://github.com/lakeday-org/perch/commit/dacd98f6fc25c99f4f41d65bfdd8f45a28ae56ec))
* print rule breaks in perch scan ([#343](https://github.com/lakeday-org/perch/issues/343)) ([cbc6211](https://github.com/lakeday-org/perch/commit/cbc621164c81fa4b25e4baaa28fbcf41d2735675)), closes [#342](https://github.com/lakeday-org/perch/issues/342)

## [0.4.2](https://github.com/lakeday-org/perch/compare/v0.4.1...v0.4.2) (2026-10-08)


### Features

* perch coverage finds low-value tests and real coverage gaps ([#317](https://github.com/lakeday-org/perch/issues/317)) ([767a4e4](https://github.com/lakeday-org/perch/commit/767a4e4d09d0f55bf1c45eab205d6db90cfba68d))
* perch coverage finds tests in every language scan reads ([#331](https://github.com/lakeday-org/perch/issues/331)) ([0c27493](https://github.com/lakeday-org/perch/commit/0c27493c9caa8c932d4117fb1574312b65742479))
* perch coverage makes every mutant of a method, fourteen kinds ([#337](https://github.com/lakeday-org/perch/issues/337)) ([7f88076](https://github.com/lakeday-org/perch/commit/7f88076db3a5060c232a6f3e1fe219b7d10c50d0))
* perch coverage predicts which mutants your tests kill ([#320](https://github.com/lakeday-org/perch/issues/320)) ([73fc9bf](https://github.com/lakeday-org/perch/commit/73fc9bfff4ad941a617c142a46000cfe8a7b9f6a))
* PERCH_BASE_URL can point at OpenAI's Decisions API ([#335](https://github.com/lakeday-org/perch/issues/335)) ([e122e6d](https://github.com/lakeday-org/perch/commit/e122e6ded8070303386251f049f80e33439efaa2))


### Bug Fixes

* perch scan ran out of open files reading callers ([#314](https://github.com/lakeday-org/perch/issues/314)) ([b966805](https://github.com/lakeday-org/perch/commit/b966805c2f5baefd6029278af74fcbbbb2bfd7f1)), closes [#305](https://github.com/lakeday-org/perch/issues/305) [#313](https://github.com/lakeday-org/perch/issues/313)

## [0.4.1](https://github.com/lakeday-org/perch/compare/v0.4.0...v0.4.1) (2026-10-02)


### Features

* perch tells Perch Cloud which command and run sent each request ([#267](https://github.com/lakeday-org/perch/issues/267)) ([93f6730](https://github.com/lakeday-org/perch/commit/93f6730d3bdd03d7894ec70d63a688ab32b6b344))


### Bug Fixes

* a repository with no code scans its file rules instead of failing ([#250](https://github.com/lakeday-org/perch/issues/250)) ([bba684d](https://github.com/lakeday-org/perch/commit/bba684d70051ab54ef609047692dd262ae4a0455))
* perch scan --filter rule= hid perch.yaml parse errors ([#264](https://github.com/lakeday-org/perch/issues/264)) ([879944b](https://github.com/lakeday-org/perch/commit/879944bc330bc0b5c7b203200616f939b4af3386))
* perch scan asked again about unchanged methods when lines above them moved ([#310](https://github.com/lakeday-org/perch/issues/310)) ([7f6967d](https://github.com/lakeday-org/perch/commit/7f6967dbe1802c78f885745df02aa87ac2d0b423))
* perch scan failed on defect readings barely over 50% ([#303](https://github.com/lakeday-org/perch/issues/303)) ([613c4c4](https://github.com/lakeday-org/perch/commit/613c4c41f3728ecd5fe5c71a33b43d0e15c3253b)), closes [#302](https://github.com/lakeday-org/perch/issues/302)
* perch sent a model more questions per request than it accepts ([#265](https://github.com/lakeday-org/perch/issues/265)) ([07d38ca](https://github.com/lakeday-org/perch/commit/07d38cacba96f1def641899ec695dceeb0fd7f43))
* Rust super imports resolved to no module or the wrong one ([#287](https://github.com/lakeday-org/perch/issues/287)) ([32ecb54](https://github.com/lakeday-org/perch/commit/32ecb5441a4696d190ec28f913f970cff20dcf8d))

## [0.4.0](https://github.com/lakeday-org/perch/compare/v0.3.5...v0.4.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* report scans to Perch Cloud and replace local answer reuse ([#170](https://github.com/lakeday-org/perch/issues/170))
* A scan asks one broad bug question, `has_bug`, alerting at 60%, and `kind` names what it found. The 15 specific bug checks are gone: on held-out bug pairs they added false alerts without ranking bugs any better. Security is asked only with `--filter type=security` or `security` in `scan_types`. It asks the 2025 CWE Top 25, less CWE-20, plus six more classes, filtered by language: 21 checks for Python, JavaScript and TypeScript, 22 for Java and Go, 28 for Rust, 30 for C and C++. Security findings use labels such as `sql_injection` and `missing_authorization`, so filters and closures written against the old labels no longer match. See the [benchmark results](https://huggingface.co/datasets/perchscan/benchmark-results).

### Features

* one bug question, and security checks chosen by CWE and language ([#172](https://github.com/lakeday-org/perch/issues/172)) ([9398517](https://github.com/lakeday-org/perch/commit/9398517a6f6c20d7af0c3aa4f85e9b1f27739a63))
* Optimize bug questions ([#228](https://github.com/lakeday-org/perch/issues/228)) ([3f15291](https://github.com/lakeday-org/perch/commit/3f15291bc371eae0134d9fd11d7680180af154c5))
* perch scan --force asks Perch Cloud again instead of using cached answers ([#233](https://github.com/lakeday-org/perch/issues/233)) ([f90c379](https://github.com/lakeday-org/perch/commit/f90c379d64dac62ae834bd6d2ac90c3ccd48253f)), closes [#232](https://github.com/lakeday-org/perch/issues/232)
* report scans to Perch Cloud and replace local answer reuse ([#170](https://github.com/lakeday-org/perch/issues/170)) ([268f9e1](https://github.com/lakeday-org/perch/commit/268f9e1ef09323ff200e5949e7ec560dca0fc39d))
* scan with Liquid AI decision models ([#230](https://github.com/lakeday-org/perch/issues/230)) ([0157f09](https://github.com/lakeday-org/perch/commit/0157f09b6abd6ff87e5f668255c02f4b97cb56cd)), closes [#229](https://github.com/lakeday-org/perch/issues/229)


### Bug Fixes

* a Choice names at most 128 lines, which is what Perch Cloud's bug model accepts ([#243](https://github.com/lakeday-org/perch/issues/243)) ([43cf831](https://github.com/lakeday-org/perch/commit/43cf831e8e22bccd885bed2b4be43dc8b4775be2))
* a method or file needing more than 64 requests was skipped instead of read ([#179](https://github.com/lakeday-org/perch/issues/179)) ([0f3269c](https://github.com/lakeday-org/perch/commit/0f3269c70e48b5e4cba46fafea48a7ddb64b6f9a))
* a request that meets a login refreshed under it is sent again with the new token ([#247](https://github.com/lakeday-org/perch/issues/247)) ([0d8181f](https://github.com/lakeday-org/perch/commit/0d8181f0fb878fcbdd91ad1bc977c39c1a7f40e3))
* a scan that could not read some methods exits 1 instead of passing ([#249](https://github.com/lakeday-org/perch/issues/249)) ([0f6a33e](https://github.com/lakeday-org/perch/commit/0f6a33eef9afb60da990881ac4960dfc91032eeb))
* code outside a named function was never scanned ([#214](https://github.com/lakeday-org/perch/issues/214)) ([93844c7](https://github.com/lakeday-org/perch/commit/93844c75058393b99c430b8754db477398bdfbb4))
* ignore dir/** skipped only the directory's top level ([#216](https://github.com/lakeday-org/perch/issues/216)) ([63ffd5d](https://github.com/lakeday-org/perch/commit/63ffd5d2b73868c7dd64563c08f4af1d45047041))
* parser downloads are retried and happen on first use, so a GitHub error no longer stops a scan ([#245](https://github.com/lakeday-org/perch/issues/245)) ([dc538f2](https://github.com/lakeday-org/perch/commit/dc538f2de821866911d801180579e754fa052fe1))
* perch check never asked mentions or callers-of rules ([#209](https://github.com/lakeday-org/perch/issues/209)) ([66a6999](https://github.com/lakeday-org/perch/commit/66a6999db4957522d75d47e2d592b849819e51c4))
* perch issues &lt;id&gt; printed documented NaN% on a default scan ([#165](https://github.com/lakeday-org/perch/issues/165)) ([b50eb63](https://github.com/lakeday-org/perch/commit/b50eb6365fee3fc94ae2b761b558dce0f86d8f08))
* perch no longer asks which line a defect or broken rule is on; a finding points at its method ([#248](https://github.com/lakeday-org/perch/issues/248)) ([389d15a](https://github.com/lakeday-org/perch/commit/389d15a3766927f2ced36bbb833f14d86ea8aeb4))
* perch scan &lt;path&gt; read nothing when ignore covered it ([#177](https://github.com/lakeday-org/perch/issues/177)) ([eaa137b](https://github.com/lakeday-org/perch/commit/eaa137bf229ba5947740ea0c82820bd5517b17fb))
* perch scan flagged code outside functions as misnamed ([#224](https://github.com/lakeday-org/perch/issues/224)) ([0a71e83](https://github.com/lakeday-org/perch/commit/0a71e83e6ded6ca5941f4f0f75eb79f80ee763e3))
* perch scan kept rule answers about edited comments and deleted tests ([#213](https://github.com/lakeday-org/perch/issues/213)) ([c4ef3c1](https://github.com/lakeday-org/perch/commit/c4ef3c1ee9329d3fac93dcbf0df5ea09ab9d7cf8))
* pull requests ran Perch twice ([#211](https://github.com/lakeday-org/perch/issues/211)) ([3903626](https://github.com/lakeday-org/perch/commit/3903626842356be8cf65b8af2af16027e77c6379))
* security questions no longer treat the operator's own arguments as untrusted ([#241](https://github.com/lakeday-org/perch/issues/241)) ([2256b58](https://github.com/lakeday-org/perch/commit/2256b58e2f62bd5de023368f76187ec8cbeb7887)), closes [#240](https://github.com/lakeday-org/perch/issues/240)


### Performance Improvements

* scan reads methods in a rolling pool of 32 and asks file rules alongside searches ([#244](https://github.com/lakeday-org/perch/issues/244)) ([7e1c704](https://github.com/lakeday-org/perch/commit/7e1c7041a0d9ab41928495ce400792c8eea677bf))

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
