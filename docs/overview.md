# PromptHash Stellar Overview

## Summary

PromptHash Stellar is a Soroban-native marketplace for encrypted prompt licensing. It is designed for creators who want to sell reusable AI prompt assets and for buyers who want verifiable access rights backed by Stellar transactions.

## Product Direction

The project treats prompts as licensable digital goods, not transferable collectibles. That distinction matters because:

- creators need repeatable monetization
- buyers need durable access, not speculative ownership semantics
- the platform needs transparent fee routing and access control

## Target Users

- AI prompt creators selling domain-specific workflows
- builders packaging internal playbooks as paid prompt products
- operators, marketers, analysts, and founders buying reusable prompt assets
- Stellar developers looking for a concrete Soroban commerce reference

## Current Functional Scope

- create prompt listings with encrypted full content
- browse public previews and prices
- buy access rights in XLM
- unlock plaintext only after wallet signature verification and on-chain access checks
- manage created and purchased prompt catalogs by wallet address

## Why This Matters For Stellar

PromptHash Stellar introduces a practical digital goods model to the ecosystem:

- XLM becomes the settlement asset for creator commerce
- Soroban contract state becomes the source of truth for access rights
- developers get a concrete example of how to combine contract state, wallet auth, and gated delivery

## Honest Project Status

This repository is an early-stage but functional foundation. It already includes:

- the core Soroban contract
- listing and purchase flows in the frontend
- a challenge-based unlock mechanism

It still needs additional hardening around indexing, mainnet deployment readiness, and operational workflows before production launch.
