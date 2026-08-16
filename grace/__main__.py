"""Allow `python -m grace` to run the same entry as the `grace` console script."""

import sys

from grace.cli.index import main

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as err:  # never expose a raw traceback to normal users
        print(f"Grace couldn't complete that request. ({err})", file=sys.stderr)
        sys.exit(1)
