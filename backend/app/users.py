"""Password hashing and validation for DB-backed user accounts.

Ported from accordance's auth/passwords.py: PBKDF2-SHA256 with a random
salt per password, stored as ``algo$iterations$salt$hash`` so the format
is self-describing and verifiable without extra tables.
"""

import base64
import hashlib
import hmac
import secrets

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 240_000

MIN_PASSWORD_LEN = 8
MIN_USERNAME_LEN = 1


def hash_password(password: str, *, iterations: int = _ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, iterations
    )
    return (
        f"{_ALGO}${iterations}$"
        f"{base64.b64encode(salt).decode()}$"
        f"{base64.b64encode(dk).decode()}"
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_b64, hash_b64 = stored.split("$")
        if algo != _ALGO:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        iterations = int(iters_s)
    except (ValueError, TypeError):
        return False
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, iterations
    )
    return hmac.compare_digest(dk, expected)
