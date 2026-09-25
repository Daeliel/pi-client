"""Example API acceptance scenario — copy to .pi/scenarios/ and adapt.

Requires: pip install pytest httpx
Run via: python -m pytest .pi/scenarios/example-api.test.py -q
"""

import httpx


def test_health_endpoint_returns_ok():
    """Given the API is running on localhost:8000, GET /health returns 200."""
    response = httpx.get("http://127.0.0.1:8000/health", timeout=5.0)
    assert response.status_code == 200
