"""Browser-use availability (port of src/agents/browser.ts)."""


def browser_availability() -> dict:
    return {
        "available": False,
        "reason": (
            "No browser automation is installed in this environment (e.g. Playwright/Puppeteer). "
            "Browser verification is not available from the CLI — verify rendering manually or install a browser backend."
        ),
    }
