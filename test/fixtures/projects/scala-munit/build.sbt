ThisBuild / scalaVersion := "3.3.3"
ThisBuild / organization := "com.acme"

lazy val root = (project in file("."))
  .settings(
    name := "parcel",
    libraryDependencies += "org.scalameta" %% "munit" % "1.0.0" % Test,
    testFrameworks += new TestFramework("munit.Framework"),
  )
