import unittest
import reference_mapping as mapping

class MappingTests(unittest.TestCase):
    def test_only_supplied_candidate_ids_can_be_selected(self):
        source=[{"id":"person-1","region":{"x":.1}}];reference=[{"id":"person-2","region":{"x":.6}}]
        value={"donor":"person-2","target":"person-1","description":"Red jacket to left man","clarification":""}
        self.assertEqual(mapping.validate(value,source,reference),{"reference":{"x":.6},"target":{"x":.1}})
        with self.assertRaises(ValueError):mapping.validate({**value,"donor":"invented"},source,reference)
        with self.assertRaises(ValueError):mapping.validate({**value,"clarification":"Which man?"},source,reference)
        self.assertIsNone(mapping.validate({"donor":"","target":"","description":"","clarification":"Which man?"},source,reference))
