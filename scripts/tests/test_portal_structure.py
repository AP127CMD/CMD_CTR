import fetch_schedule as fs
import pytest


def test_check_critical_rpcs_passes_when_present():
    fs._check_critical_rpcs(["getStudentSchedule", "getBatches", "getInstructors"])


def test_check_critical_rpcs_raises_when_missing():
    with pytest.raises(fs.CriticalRPCMissingError):
        fs._check_critical_rpcs(["getBatches", "getInstructors"])


def test_check_critical_rpcs_error_names_the_missing_function():
    with pytest.raises(fs.CriticalRPCMissingError, match="getStudentSchedule"):
        fs._check_critical_rpcs([])
