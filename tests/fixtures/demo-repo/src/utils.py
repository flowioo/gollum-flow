def find_first(items, target):
    for i, item in enumerate(items):
        if item == target:
            return i
    return -1

def find_last(items, target):
    i = len(items) - 1
    while i >= 0:
        if items[i] == target:
            return i
        i -= 1  # FIXED
    return -1
