// Package msix tells an agent that runs from an MSIX package (the Microsoft
// Store build) about that package.
//
// Only a process with the package's identity may run the package's files,
// and the programs the agent starts from outside the package (git, the
// terminal's shell) have none. They can start the agent only through the
// App Execution Alias the package declares for it (build/appx-manifest.cjs),
// which hands it the identity.
package msix

// agentAlias is the App Execution Alias the package declares for the agent.
const agentAlias = "nexuscode-agent.exe"
