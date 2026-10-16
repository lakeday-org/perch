ThisBuild / scalaVersion := "3.3.3"
ThisBuild / organization := "com.acme"

lazy val root = (project in file("."))
  .settings(
    name := "ledger",
    libraryDependencies += "org.scalatest" %% "scalatest" % "3.2.18" % Test,
  )
