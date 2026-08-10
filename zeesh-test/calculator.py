"""Simple calculator module providing basic arithmetic operations.

Functions:
- add(a, b)
- subtract(a, b)
- multiply(a, b)
- divide(a, b) -> raises ZeroDivisionError if b is zero
"""

def add(a, b):
    """Return the sum of a and b."""
    return a + b


def subtract(a, b):
    """Return the difference a - b."""
    return a - b


def multiply(a, b):
    """Return the product of a and b."""
    return a * b


def divide(a, b):
    """Return a divided by b.

    Raises:
        ZeroDivisionError: If b is zero.
    """
    if b == 0:
        raise ZeroDivisionError("division by zero")
    return a / b
