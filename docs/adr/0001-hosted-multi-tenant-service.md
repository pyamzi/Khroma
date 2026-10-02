# Khroma is a hosted multi-tenant service

The original design (`docs/superpowers/specs/2026-09-10-opengallery-design.md`) made Khroma a self-hosted app for one studio on its own NAS, with photos as folders on a network share and multi-tenant SaaS listed as a non-goal. On 2026-09-30 we reversed that: Khroma becomes a hosted service where any Studio signs up, keeps its Library in cloud storage, and pays by subscription for storage and searches. We chose this because the goal is a tool anyone can add to Claude without running a server, and because none of the self-hosted app had shipped, which made this the cheapest moment to change course.

## Considered options

- Keep self-hosted and add a hosted edition: rejected because every feature would need two storage models and two account models.
- Build hosted first and revive self-hosted later: rejected in favor of a single product direction.

## Consequences

- The NAS and network-share workflow goes away, including Lightroom editing RAWs in place on the share; the Lightroom plugin uploads instead.
- The design spec's non-goals, storage model, and deployment sections are superseded and need a new spec before implementation.
