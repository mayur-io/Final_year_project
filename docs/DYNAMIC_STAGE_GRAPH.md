# TOPBAR_STAGE_GRAPH.md

# Purpose

This document defines the UI architecture and design philosophy of Splato's top navigation component.

This is **NOT** a progress bar.

This is **NOT** breadcrumbs.

This is **NOT** a timeline.

This is **NOT** a stage selector.

It is the **Dynamic Stage Graph**, implemented as a **floating navigation bar** that evolves with the project and serves as the primary navigation system inside the Project Workbench.

---

# Core Philosophy

The top bar should feel like a living object.

The graph is the source of navigation. The Active Stage is simply the currently selected node in that graph.

Instead of replacing components or navigating between pages, the top bar continuously grows with the project.

The interface should become progressively more powerful as the project evolves while remaining visually minimal.

---

# Single Source of Truth

The Dynamic Stage Graph is the navigation state of the Workbench.

There is exactly one selected node in the graph.

That selected node is the Active Stage.

The Active Stage Workspace is simply the interface rendered for the selected node.

Graph Selection
↓
Active Stage
↓
Workspace

The workspace never owns navigation.

Navigation always originates from the graph.

Changing the selected node immediately changes the Active Stage Workspace.

Creating a branch or progressing to another stage changes the selected node, not the page.

# Progressive Disclosure

One of Splato's core design principles.

Never show more information than the user currently needs.

The UI reveals information in layers.

## Level 1 — Navigation

User only needs to know

- Current Project
- Current Stage
- Current Version

Nothing else.

Example

Project ▶ [Video v2] ▶ [Frames v1] ▶ [Recon v4] ▶ [Viewer v4]

---

## Level 2 — Structure

User expands the graph.

Now reveal

- Branches
- Version relationships
- Project details

Do NOT reveal statistics or metadata.

The purpose of expansion is understanding project structure.

---

## Level 3 — Information

User explicitly requests information through

⋮ → Information

Only then reveal

- Statistics
- Processing information
- Metadata
- Module information
- Timestamps
- Inputs
- Outputs

Information is never automatically shown.

---

## Level 4 — Workspace

Selecting a stage changes the selected workflow node.

The selected workflow node becomes the Active Stage.

The Active Stage Workspace automatically renders the interface for that node.

No page navigation occurs.

The graph never becomes an inspector.

Editing always happens inside the workspace.

---

# Floating Workbench Navbar

The Dynamic Stage Graph is implemented as one floating navbar.

It is NOT a section.

It does NOT have a title.

There is NO

- "Dynamic Stage Graph"
- "Timeline"
- "Workflow"
- "Main Branch"

visible anywhere.

The navbar itself is the graph.

---

# Project is the Root

The graph begins from the project.

The Project is the root node of the Workbench.

Every workflow begins from the project.

The currently active lineage always begins with the project and continues through the selected node.

Example

Project ▶ Video ▶ Frames ▶ Reconstruction ▶ Viewer

The project owns the graph.

The graph owns every stage and every branch.

There is never more than one project root.

The project owns the graph.

The graph owns the branches.

---

# Active Lineage

Collapsed mode always visualizes the currently active lineage.

Inactive branches remain hidden until expansion.

Example

Project ▶ Video v2 ▶ Frames v1 ▶ Recon v4 ▶ Viewer v4

This represents the exact path from the project root to the currently selected node.

Changing the selected node immediately updates the active lineage.

# Stage Lifecycle

Every stage is a workflow node.

A workflow node can

- be created
- become active
- generate children
- generate branches
- become inactive
- become historical

The graph continuously evolves as nodes are created.

The graph is never regenerated from scratch.

# Workspace Relationship

The Dynamic Stage Graph never edits data.

It never contains inspectors.

It never contains processing controls.

Its only responsibility is representing and navigating the project structure.

Editing always occurs inside the Active Stage Workspace.

The workspace is a projection of the currently selected node.

Changing the selected node immediately changes the workspace.

The graph and the workspace are two synchronized views of the same project state.

# Stage Capsules

Every stage is represented by a capsule.

Example

┌─────────────────────┐
│ Reconstruction v4 │
└─────────────────────┘

The stage name is the primary identity.

The version is secondary.

Version should appear as a subtle badge or metadata inside the capsule.

Never display

Reconstruction v4

as plain text.

---

# Version Visibility

Versions are always visible.

Even in collapsed mode.

Example

Project ▶ [Video v2] ▶ [Frames v1] ▶ [Recon v4] ▶ [Viewer v4]

This avoids ambiguity when multiple branches exist.

The collapsed graph always represents the currently active lineage.

---

# Dynamic Stage Generation

Stages are NOT predefined.

The graph grows as the project progresses.

Example

New Project

Project

↓

Import Video

Project ▶ Video

↓

Extract Frames

Project ▶ Video ▶ Frames

↓

Preprocessing

Project ▶ Video ▶ Frames ▶ Preprocessing

↓

Reconstruction

Project ▶ Video ▶ Frames ▶ Preprocessing ▶ Reconstruction

Every project may generate a different graph.

Examples

Video Project

Project ▶ Video ▶ Frames ▶ Reconstruction ▶ Viewer

Gaussian Splat Import

Project ▶ Viewer

Mesh Import

Project ▶ Viewer ▶ Export

The graph evolves from the current project state.

New workflow nodes are appended as the project progresses.

Existing nodes are preserved to maintain project history.

The graph is never rebuilt from scratch.

Never hardcode stage order.

---

# Node Selection

There is exactly one selected node at any time.

The selected node

- is highlighted in the graph
- defines the Active Stage
- determines the Active Lineage
- renders the Active Stage Workspace

Changing the selected node updates the entire Workbench while preserving spatial context.

# Collapsed State

Purpose

Maximum workspace.

Only essential navigation.

Visible

- Project
- Active stages
- Versions
- Expand button

Nothing else.

---

# Expanded State

Expansion does NOT dump every detail.

Expansion reveals

- Project details
- Branches
- Version relationships

Nothing else.

Statistics remain hidden.

Metadata remains hidden.

Processing information remains hidden.

---

# Stage Details

Stage details are NOT shown after expanding.

They are requested explicitly.

Interaction

Hover

↓

⋮

↓

Information

↓

Stage Details

This follows Progressive Disclosure.

---

# Context Menu

Every stage capsule contains

⋮

Visible only on hover.

Possible actions

- Select
- Information
- Reprocess
- Compare
- Rename
- Duplicate
- Delete

The graph stays clean until interaction.

---

# Branch Visualization

Branches grow from the stage that created them.

Never from empty space.

Correct

Recon v4
│
├── Recon v5
└── Recon v6

Incorrect

Main Branch

────────────

The project is the root.

Stages create branches.

---

# Animation Philosophy

Animation is part of the product identity.

Nothing should instantly appear.

Nothing should instantly disappear.

Every transition should feel continuous.

---

# Expand Animation

When expanding

Navbar height increases smoothly.

Project details fade in.

Branches grow downward.

Connections animate.

Spacing adjusts smoothly.

Nothing jumps.

---

# Collapse Animation

Reverse of expansion.

Information fades first.

Branches retract.

Navbar height decreases.

State remains preserved.

---

# Hover Animation

Hovering a capsule

- Slight elevation
- Soft highlight
- ⋮ fades in

No aggressive movement.

---

# Branch Animation

Branches should feel like they grow from the parent stage.

Connections animate.

Children fade into place.

---

# Design Philosophy

Minimal by default.

Powerful on demand.

Information should always require intention.

Every interaction reveals exactly one additional layer of understanding.

Never overwhelm the user.

Never expose implementation details before they are requested.

The graph should feel alive, continuous and spatially stable.

Users should always know where they are without losing visual context.

The Dynamic Stage Graph should feel less like a UI component and more like a living navigation object that evolves together with the project.
