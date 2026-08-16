"""Simple calculator module.

Provides basic arithmetic operations.

Functions
---------
add(a, b)
    Return the sum of a and b.

subtract(a, b)
    Return the difference a - b.

multiply(a, b)
    Return the product of a and b.

divide(a, b)
    Return the quotient a / b. Raises ZeroDivisionError if b is zero.
"""

from __future__ import annotations


def add(a: float | int, b: float | int) -> float:
    """Return the sum of *a* and *b*.

    Parameters
    ----------
    a, b
        Numbers to add.

    Returns
    -------
    float
        The sum of *a* and *b*.
    """
    return a + b


def subtract(a: float | int, b: float | int) -> float:
    """Return the difference *a* - *b*.

    Parameters
    ----------
    a, b
        Numbers to subtract.

    Returns
    -------
    float
        The result of *a* - *b*.
    """
    return a - b


def multiply(a: float | int, b: float | int) -> float:
    """Return the product of *a* and *b*.

    Parameters
    ----------
    a, b
        Numbers to multiply.

    Returns
    -------
    float
        The product of *a* and *b*.
    """
    return a * b


def divide(a: float | int, b: float | int) -> float:
    """Return the quotient *a* / *b*.

    Parameters
    ----------
    a, b
        Numbers to divide.

    Raises
    ------
    ZeroDivisionError
        If *b* is zero.

    Returns
    -------
    float
        The result of *a* / *b*.
    """
    if b == 0:
        raise ZeroDivisionError("division by zero")
    return a / b

__all__ = ["add", "subtract", "multiply", "divide"]
