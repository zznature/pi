#!/usr/bin/env python3
"""Test fixture that violates the V2 bridge stdout protocol."""

print("not-json", flush=True)
