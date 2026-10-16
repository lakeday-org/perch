/**
 * Java fixtures: JUnit 5, JUnit 4 and TestNG, run by Maven Surefire and by Gradle, with JaCoCo's XML report.
 *
 * Each application keeps only its sources and tests. The build file a CI runner would have is written into the temporary copy:
 * a pom.xml for Maven, and for order-service-java also a build.gradle, run as a second way of running the same tests. Surefire's
 * enablePropertiesElement=false keeps the <properties> element, every system property of the JVM that ran the tests, out of the
 * file for a class whose tests all passed. Surefire writes it for a class with a failing test whatever that setting says, so the
 * machine must not be in it: the tests run with user.name `fixture`, user.home the project directory, and the temporary and
 * native-library directories its build directory, and Maven's repository
 * and Gradle's user home are inside the temporary copy, so every path in the output is under the copy and made relative.
 *
 * Environment:
 *   PERCH_FIXTURE_JAVA_HOME  the JDK to build and test with (default JAVA_HOME, else whatever java is on PATH). It becomes
 *                            JAVA_HOME, and its bin/ goes first on PATH, for Maven and Gradle.
 */
import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { report, run, testEnv } from './common.mjs';

const JUNIT5 = '5.14.4';
const JUNIT4 = '4.13.2';
const TESTNG = '7.12.0';
const MOCKITO = '5.24.0';
const JACOCO = '0.8.15';
const SUREFIRE = '3.5.6';

const javaHome = process.env.PERCH_FIXTURE_JAVA_HOME || process.env.JAVA_HOME || null;
const withJava = env => (javaHome ? { ...env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}:${env.PATH ?? ''}` } : env);
const env = withJava(testEnv);

/** True when `command args` runs and exits 0 with the JDK above. */
const works = (command, args) => {
  const result = spawnSync(command, args, { env: withJava(process.env), encoding: 'utf8' });
  return !result.error && result.status === 0;
};

const dependency = (group, artifact, version) =>
  `    <dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><scope>test</scope></dependency>`;

const FRAMEWORKS = {
  junit5: [dependency('org.junit.jupiter', 'junit-jupiter', JUNIT5)],
  junit4: [dependency('junit', 'junit', JUNIT4)],
  testng: [dependency('org.testng', 'testng', TESTNG)],
};

const pom = (artifact, framework) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId>
  <artifactId>${artifact}</artifactId>
  <version>0.0.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
${FRAMEWORKS[framework].join('\n')}
${dependency('org.mockito', 'mockito-core', MOCKITO)}
  </dependencies>
  <build>
    <sourceDirectory>src</sourceDirectory>
    <testSourceDirectory>test</testSourceDirectory>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>${SUREFIRE}</version>
        <configuration>
          <enablePropertiesElement>false</enablePropertiesElement>
          <systemPropertyVariables>
            <user.name>fixture</user.name><user.home>\${project.basedir}</user.home>
            <java.io.tmpdir>\${project.build.directory}</java.io.tmpdir><java.library.path>\${project.build.directory}</java.library.path>
          </systemPropertyVariables>
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>${JACOCO}</version>
        <executions>
          <execution><goals><goal>prepare-agent</goal></goals></execution>
          <execution><id>report</id><phase>verify</phase><goals><goal>report</goal></goals></execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
`;

const gradleBuild = `plugins {
    id 'java'
    id 'jacoco'
}

repositories { mavenCentral() }

sourceSets {
    main { java { srcDirs = ['src'] } }
    test { java { srcDirs = ['test'] } }
}

dependencies {
    testImplementation platform('org.junit:junit-bom:${JUNIT5}')
    testImplementation 'org.junit.jupiter:junit-jupiter'
    testRuntimeOnly 'org.junit.platform:junit-platform-launcher'
    testImplementation 'org.mockito:mockito-core:${MOCKITO}'
}

tasks.withType(JavaCompile).configureEach { options.release = 17 }

jacoco { toolVersion = '${JACOCO}' }

test {
    useJUnitPlatform()
    // The tests run as no one in particular, so what they write names neither the user nor their home directory.
    systemProperty 'user.name', 'fixture'
    systemProperty 'user.home', projectDir.absolutePath
    ignoreFailures = true
    finalizedBy jacocoTestReport
}

jacocoTestReport {
    dependsOn test
    reports {
        xml.required = true
        html.required = false
        csv.required = false
    }
}
`;

/** Every TEST-*.xml a run wrote into `dir`, under `into`/. A run that wrote none is an error. */
async function junitFiles(copy, dir, into) {
  const files = {};
  for (const name of (await readdir(dir)).filter(name => /^TEST-.*\.xml$/.test(name)).sort()) files[`${into}/${name}`] = await report(copy, join(dir, name));
  if (!Object.keys(files).length) throw new Error(`the run wrote no TEST-*.xml in ${dir}`);
  return files;
}

/** Surefire's JUnit XML, one file per class, and JaCoCo's XML report, under maven/. */
async function maven(copy, app, framework) {
  await writeFile(join(copy.real, 'pom.xml'), pom(app, framework));
  run('mvn', ['-B', '-Dmaven.test.failure.ignore=true', `-Dmaven.repo.local=${join(copy.real, '.m2')}`, 'verify'], { cwd: copy.real, env, tests: true });
  return {
    ...await junitFiles(copy, join(copy.real, 'target/surefire-reports'), 'maven/junit'),
    'maven/jacoco.xml': await report(copy, join(copy.real, 'target/site/jacoco/jacoco.xml')),
  };
}

/** Gradle's JUnit XML, one file per class, and its jacocoTestReport XML, under gradle/. */
async function gradle(copy, app) {
  await writeFile(join(copy.real, 'settings.gradle'), `rootProject.name = '${app}'\n`);
  await writeFile(join(copy.real, 'build.gradle'), gradleBuild);
  run('gradle', ['--no-daemon', '--console=plain', 'test', 'jacocoTestReport'], { cwd: copy.real, env: { ...env, GRADLE_USER_HOME: join(copy.real, '.gradle-home') }, tests: true });
  return {
    ...await junitFiles(copy, join(copy.real, 'build/test-results/test'), 'gradle/junit'),
    'gradle/jacoco.xml': await report(copy, join(copy.real, 'build/reports/jacoco/test/jacocoTestReport.xml')),
  };
}

const missing = tools => () => {
  const absent = [];
  if (!works('java', ['-version'])) absent.push('a JDK (java; set PERCH_FIXTURE_JAVA_HOME)');
  if (tools.includes('mvn') && !works('mvn', ['-v'])) absent.push('Maven (mvn)');
  if (tools.includes('gradle') && !works('gradle', ['--version'])) absent.push('Gradle (gradle)');
  return absent;
};

export const apps = {
  'order-service-java': {
    missing: missing(['mvn', 'gradle']),
    async generate(copy) {
      const built = await maven(copy, 'order-service-java', 'junit5');
      return { ...built, ...await gradle(copy, 'order-service-java') };
    },
  },
  'order-service-java-junit4': { missing: missing(['mvn']), generate: copy => maven(copy, 'order-service-java-junit4', 'junit4') },
  'order-service-java-testng': { missing: missing(['mvn']), generate: copy => maven(copy, 'order-service-java-testng', 'testng') },
};
