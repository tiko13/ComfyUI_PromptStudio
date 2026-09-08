import unittest
from prompt_agent_quality import enforce_visual_evidence, combine_reference_assessment, calibration_metrics

RUBRIC = {"criteria": [{"id":"face", "hard":True, "weight":2}, {"id":"style", "hard":False, "weight":1}]}
def evaluation():
    return {"score":100,"confidence":1,"pass":True,"criteria":[{"id":"face","status":"pass","score":100,"evidence":"Face visible at center"},{"id":"style","status":"pass","score":100,"evidence":"Soft lighting visible"}]}

class QualityTests(unittest.TestCase):
    def test_missing_visual_evidence_cannot_pass(self):
        value=evaluation();value["criteria"][0]["evidence"]=""
        self.assertFalse(enforce_visual_evidence(value,RUBRIC)["pass"])
        self.assertTrue(value["pass"], "The saved assessment is immutable")

    def test_reference_comparison_cannot_rescue_failed_hard_criteria(self):
        value=evaluation();value["pass"]=False;value["criteria"][0].update(status="fail",score=0)
        self.assertFalse(combine_reference_assessment(value,evaluation(),RUBRIC)["pass"])

    def test_reference_mismatch_and_permutation_are_conservative(self):
        ref=evaluation();ref["pass"]=False;ref["criteria"][0].update(status="partial",score=40)
        result=combine_reference_assessment(evaluation(),ref,RUBRIC)
        ref["criteria"].reverse()
        self.assertEqual(combine_reference_assessment(evaluation(),ref,RUBRIC),result)
        self.assertEqual(result["score"],60);self.assertFalse(result["pass"])

    def test_calibration_requires_actual_rows_and_reports_order_variance(self):
        self.assertFalse(calibration_metrics([])["measured"])
        result=calibration_metrics([{"human_score":70,"score":80,"permuted_score":72}])
        self.assertEqual(result["human_mean_absolute_error"],10)
        self.assertFalse(result["order_within_tolerance"])
        with self.assertRaises(ValueError):calibration_metrics([{"human_score":0,"score":float('nan'),"permuted_score":0}])
