import sys


def main():
    try:
        print(len(sys.argv))
    except ValueError as err:
        print(err)


if __name__ == "__main__":
    main()
