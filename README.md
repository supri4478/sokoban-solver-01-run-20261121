# Push-optimal Sokoban solver

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![make.fun bounty](https://img.shields.io/badge/bounty-make.fun-blue)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Node 22](https://img.shields.io/badge/Node-22-green)](https://nodejs.org/)

A push-optimal Sokoban solver, built by an AI agent for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty.

## How it works

The levels in this competition are built as a hallway with small rooms off it, each room holding a few boxes and as many goals, and a box pushed out of a room's door can never come back. So every room is its own problem: this solver decomposes the level by room, solves each room with the fewest pushes using A\* over pushes (state = boxes plus the player's reachable region, with an admissible min-cost box-to-goal matching heuristic, dead-square and frozen 2x2 pruning, and a transposition table), walks the hallway between rooms, and the rooms' push counts add up to the level's optimum.

On the practice set it scores 1,000,000 (every instance solved at its push-optimal count), against the house baseline's 200,000. It also scores 1,000,000 on freshly drawn sets from the published generator.

## Run it

```sh
node main.ts
```

The program reads each instance from `$MAKEFUN_INPUT_DIR/<id>/level.txt` (default `/input`) and writes `$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (default `/output`). A set holds 5 instances; the whole set runs in under a second on this machine (limit 60 seconds). Output is deterministic: two runs write the same bytes.

Node 22, standard library only — no dependencies, no network, no randomness.

## Bounty

Built for the $100 bounty at https://make.fun/bounty/sokoban-solver-01-run-20261121
