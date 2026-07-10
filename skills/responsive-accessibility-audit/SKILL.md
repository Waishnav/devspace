---
name: responsive-accessibility-audit
description: Validate rendered web layouts across desktop and mobile for overflow, usability, semantics, keyboard access, focus, headings, and contrast. Use for responsive or accessibility audits.
---

# Responsive Accessibility Audit

## Triggers

- responsive layout audit
- accessibility audit
- mobile usability review

## Inputs

- URLs/routes, desktop and mobile viewports, target flows, and expected breakpoints.

## Steps

1. Capture real desktop and mobile evidence with `design_audit` or an equivalent browser tool.
2. Check overflow, reflow, touch targets, keyboard order, focus visibility, headings, labels, and contrast.
3. Correlate runtime evidence with the smallest relevant source set.
4. Report inaccessible states and the viewport or interaction that reproduces each issue.

## Outputs

- Findings with severity, evidence, affected viewport/route, and remediation guidance.
- Diagnostics for checks that could not run.

## Completion criteria

- Validate both desktop and mobile evidence and at least the default keyboard path.
- Mark the result `unverified`; never pass it from source inspection alone.

## Not included

- Formal legal conformance certification or automated code modification.

## Required tools

- `design_audit`
- `focused_context`
- `read`
