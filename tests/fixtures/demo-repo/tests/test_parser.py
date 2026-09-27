import sys
sys.path.insert(0, 'src')
from parser import parse_int, parse_float

def test_parse_int():
    assert parse_int("42") == 42
    assert parse_int("") == 0

def test_parse_float():
    assert parse_float("3.14") == 3.14