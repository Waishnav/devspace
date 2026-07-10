---
name: design-system-audit
description: Audit a rendered web interface for visual hierarchy, spacing, typography, component consistency, and interaction states. Use for design-system compliance or UI consistency reviews.
---

# Design System Audit

## Triggers

- design system audit
- visual consistency review
- component state review

## Inputs

- Rendered desktop and mobile evidence, routes, and target components.
- Existing tokens, components, or design-system rules when available.

## Steps

1. Obtain real screenshots or `design_audit` artifacts before judging appearance.
2. Compare hierarchy, spacing, typography, color, components, focus, hover, and selected states.
3. Separate verified findings from items that require another state or viewport.
4. Rank findings by user impact and cite the route, component, and evidence.

## Outputs

- Severity-ordered findings, evidence, affected routes/components, and recommended fixes.
- An explicit `verified` or `unverified` result.

## Completion criteria

- Inspect representative desktop and mobile states and all interaction states in scope.
- Do not pass the audit when rendered evidence is unavailable.

## Not included

- Rebranding, speculative redesign, or code changes unless separately requested.

## Required tools

- `design_audit`
- `focused_context`
- `read`
