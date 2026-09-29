import sys

LIMIT = 3


def main(argv):
    return len(argv[:LIMIT])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
