import pytest

def pytest_addoption(parser):
    parser.addoption("--live", action="store_true", help="run tests that load models on the GPU")

def pytest_collection_modifyitems(config, items):
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="needs --live (GPU + model download)")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)
