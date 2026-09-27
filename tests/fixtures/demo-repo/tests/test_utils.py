import sys
sys.path.insert(0, 'src')
from utils import find_first, find_last

def test_find_first():
    assert find_first([1, 2, 3, 2, 1], 2) == 1
    assert find_first([], 5) == -1

def test_find_last():
    assert find_last([1, 2, 3, 2, 1], 2) == 3
    assert find_last([], 5) == -1