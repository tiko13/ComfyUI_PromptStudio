"""Synthetic prompt evaluations; importing this package never calls a provider."""

from .cases import CASE_SCHEMA_VERSION, SUITE_VERSION, cases
from .invariants import check_output, validate_cases

__all__ = ["CASE_SCHEMA_VERSION", "SUITE_VERSION", "cases", "check_output", "validate_cases"]
