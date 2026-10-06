"""Conservative routing tests without loading detector weights or a provider."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("reference_detection_test")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__ + ".reference_detection", ROOT / "reference_detection.py")
detection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(detection)


class DetectionTests(unittest.TestCase):
    def test_unspecified_multiple_people_require_selection_in_either_direction(self):
        one={"available":True,"boxes":[{"score":.9}]}
        two={"available":True,"boxes":[{"score":.9},{"score":.85}]}
        for results,word in (([two,one],"recipient"),([one,two],"donor")):
            with patch.object(detection,"detect",side_effect=results):
                self.assertIn(word,detection.pose_mapping_clarification(self.payload(),lambda image:image))
        for data in (self.payload(instruction="Use the left person"),self.payload(guide={"scope":"whole"}),self.payload(targeting={"target":{"x":0,"y":0,"width":.5,"height":1},"reference":{"x":0,"y":0,"width":.5,"height":1}})):
            with patch.object(detection,"detect",side_effect=AssertionError("No detection needed")):
                self.assertIsNone(detection.pose_mapping_clarification(data,lambda image:image))
        with patch.object(detection,"detect",return_value={"available":False}):
            self.assertIsNone(detection.pose_mapping_clarification(self.payload(),lambda image:image))

    def payload(self, **entry):
        return {"model": "qwen_image_2_1", "source_image": {"filename": "source.png"}, "user_text": "",
                "references": [{"role": "pose", "image": {"filename": "ref.png"}, **entry}]}

    def test_shortcut_requires_both_clear_images(self):
        with patch.object(detection, "detect", return_value={"available": True, "single_person": True}) as detect:
            result = detection.triage(self.payload(), lambda image: image["filename"])
            self.assertEqual(result["decision"], "simple")
            self.assertEqual([call.args[0] for call in detect.call_args_list], ["source.png", "ref.png"])
        for uncertain in ({"available": False}, {"available": True, "single_person": False}):
            with patch.object(detection, "detect", side_effect=[{"available": True, "single_person": True}, uncertain]):
                self.assertEqual(detection.triage(self.payload(), lambda i: i)["decision"], "deep")

    def test_complex_requests_never_spend_detector_or_llm_work(self):
        cases = [self.payload(role="clothing"), self.payload(instruction="Use the left person"),
                 self.payload(analysis="deep"), self.payload(targeting={"target": dict(x=0,y=0,width=.5,height=1)}),
                 self.payload(use="structure", guide={"type":"pose", "input":"prepared"}),
                 self.payload(use="structure", guide={"type":"depth", "input":"photo"})]
        text = self.payload(); text["user_text"] = "Make the dark haired person wear the left person's jacket"; cases.append(text)
        multiple = self.payload(); multiple["references"] *= 2; cases.append(multiple)
        with patch.object(detection, "detect", side_effect=AssertionError("Must not run")):
            for data in cases:
                with self.subTest(data=data):
                    self.assertEqual(detection.triage(data, lambda i: i)["decision"], "deep")

    def test_photo_pose_guide_and_combined_reference_qualify(self):
        with patch.object(detection, "detect", return_value={"available":True, "single_person":True}):
            for use in ("structure", "both"):
                self.assertEqual(detection.triage(self.payload(use=use, guide={"type":"pose", "input":"photo"}), lambda i:i)["decision"], "simple")

    def test_explicit_whole_guides_need_no_detection_but_never_override_instructions(self):
        with patch.object(detection,"detect",side_effect=AssertionError("No detector needed")):
            for kind in ("pose","depth","edges","sketch"):
                for mode in ("photo","prepared"):
                    data=self.payload(use="structure",guide={"type":kind,"input":mode,"scope":"whole"})
                    self.assertEqual(detection.triage(data,lambda i:i)["decision"],"simple")
                    data["user_text"]="only the left person"
                    self.assertEqual(detection.triage(data,lambda i:i)["decision"],"deep")

    def test_weak_extra_small_and_border_people_prevent_simple(self):
        box = {"score": .9, "region": dict(x=.2, y=.1, width=.4, height=.8)}
        self.assertTrue(detection._single([box]))
        self.assertFalse(detection._single([]))
        self.assertFalse(detection._single([box, {**box, "score":.16}]))
        self.assertFalse(detection._single([{**box, "score":.7}]))
        self.assertFalse(detection._single([{**box, "region":dict(x=0, y=0, width=1, height=1)}]))
        self.assertFalse(detection._single([{**box, "region":dict(x=.2, y=.2, width=.1, height=.1)}]))

    def test_busy_and_failed_detector_are_optional(self):
        with detection._lock:
            self.assertFalse(detection.detect("unused")["available"])
        with patch.object(detection, "_detect", side_effect=RuntimeError("Unavailable")):
            self.assertFalse(detection.detect("unused")["available"])
        self.assertTrue(detection._lock.acquire(blocking=False)); detection._lock.release()

    def test_cache_tracks_content_not_filename_and_normalizes_boxes(self):
        import hashlib
        import time
        import numpy as np
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.onnx"; model.write_bytes(b"test")
            image = root / "image.png"; Image.new("RGB", (100,200), "white").save(image)
            session = types.SimpleNamespace(get_inputs=lambda:[types.SimpleNamespace(name="input")])
            calls = []
            session.run = lambda *args: calls.append(args) or [np.array([[[50.,100.,60.,140.,1.,.9]]])]
            runtime = types.ModuleType("onnxruntime")
            runtime.SessionOptions = types.SimpleNamespace
            runtime.InferenceSession = lambda *args,**kw: session
            helper = types.ModuleType("custom_controlnet_aux.dwpose.dw_onnx.cv_ox_det")
            helper.preprocess = lambda img,size:(img,1)
            helper.demo_postprocess = lambda values,size:values
            helper.multiclass_nms = lambda boxes,scores,*args:np.concatenate((boxes,scores,np.zeros((1,1))),axis=1)
            modules = {"onnxruntime":runtime, helper.__name__:helper}
            asset = {"sha256":hashlib.sha256(b"test").hexdigest()}
            with patch.dict(sys.modules,modules), patch.object(detection,"_model",return_value=(model,asset)), \
                 patch.object(detection,"_session",None), patch.object(detection,"_model_key",None), \
                 patch.object(detection,"_cache",detection.OrderedDict()):
                result = detection._detect(image,time.perf_counter())
                for name, expected in dict(x=.2,y=.15,width=.6,height=.7).items():
                    self.assertAlmostEqual(result["boxes"][0]["region"][name],expected)
                self.assertTrue(result["single_person"])
                self.assertTrue(detection._detect(image,time.perf_counter())["cached"])
                Image.new("RGB", (100,200), "black").save(image)
                self.assertFalse(detection._detect(image,time.perf_counter())["cached"])
                self.assertEqual(len(calls),2)
                model.write_bytes(b"new weights")
                asset["sha256"] = hashlib.sha256(b"new weights").hexdigest()
                self.assertFalse(detection._detect(image,time.perf_counter())["cached"])
                self.assertEqual(len(calls),3)


if __name__ == "__main__":
    unittest.main()
