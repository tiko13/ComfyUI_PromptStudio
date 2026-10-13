"""Exercise the actual embedded registry check without network or publishing."""

import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import textwrap
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError


ROOT = Path(__file__).resolve().parents[1]


class RegistryPublishTests(unittest.TestCase):
    def setUp(self):
        self.workflows = [ROOT / '.github' / 'workflows' / 'publish_action.yml']
        if os.environ.get('STUDIO_TEST_VIDEO') == '1':
            self.workflows.append(ROOT.parent / 'PromptStudio_Video' / '.github' / 'workflows' / 'publish_action.yml')

    def run_check(self, responses, expected=None, error=None):
        for workflow in self.workflows:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as directory:
                text = workflow.read_text(encoding='utf-8')
                source = textwrap.dedent(text.split("python - <<'PY'\n", 1)[1].split('          PY\n', 1)[0])
                root = Path(directory)
                (root / 'pyproject.toml').write_text('[project]\nname = "Example_Node"\nversion = "1.2.3"\n', encoding='utf-8')
                output = root / 'output'
                with contextlib.chdir(root), patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}), \
                        patch('urllib.request.urlopen') as request, contextlib.redirect_stdout(io.StringIO()):
                    # Fresh response streams for each workflow.
                    request.side_effect = [self.response(item) for item in responses]
                    if error:
                        with self.assertRaises(error):
                            exec(compile(source, str(workflow), 'exec'), {})
                        self.assertFalse(output.exists(), 'Errors must not authorize publication or mark success')
                    else:
                        exec(compile(source, str(workflow), 'exec'), {})
                        self.assertEqual(output.read_text(encoding='utf-8'), f'published={expected}\n')
                    self.assertEqual(request.call_args_list[0].args[0], 'https://api.comfy.org/nodes/Example_Node/versions/1.2.3')
                    if len(request.call_args_list) == 2:
                        self.assertEqual(request.call_args_list[1].args[0].get_method(), 'HEAD')

    @staticmethod
    def response(value):
        if isinstance(value, Exception):
            return value
        response = io.StringIO(json.dumps(value) if isinstance(value, dict) else '')
        response.status = value if isinstance(value, int) else 200
        return response

    @staticmethod
    def record(**overrides):
        return dict(version='1.2.3', node_id='example_node',
                    downloadUrl='https://cdn.comfy.org/publisher/Example_Node/1.2.3/node.zip', **overrides)

    def http_error(self, code):
        error = HTTPError('https://api.comfy.org/example', code, 'fixture error', {}, io.BytesIO())
        self.addCleanup(error.close)
        return error

    def test_absent_version_retries_on_next_push(self):
        self.run_check([self.http_error(404)], expected='false')

    def test_uploaded_version_skips_even_while_registry_review_is_pending(self):
        for status in ('NodeVersionStatusActive', 'NodeVersionStatusPending', 'NodeVersionStatusFlagged'):
            with self.subTest(status=status):
                self.run_check([self.record(status=status), 200], expected='true')

    def test_record_without_completed_upload_retries(self):
        self.run_check([self.record(), self.http_error(404)], expected='false')

    def test_registry_errors_never_authorize_publish(self):
        for error in (self.http_error(403), self.http_error(429), self.http_error(500), URLError('offline')):
            self.run_check([error], error=type(error))

    def test_archive_errors_never_count_as_published(self):
        for error in (self.http_error(403), self.http_error(500), URLError('offline')):
            self.run_check([self.record(), error], error=type(error))
        self.run_check([self.record(), 204], error=RuntimeError)

    def test_wrong_or_incomplete_registry_response_stops(self):
        for field, value in (('version', '9.9.9'), ('node_id', 'other'), ('downloadUrl', ''),
                             ('downloadUrl', 'https://unrelated.example/archive.zip')):
            record = self.record()
            record[field] = value
            self.run_check([record], error=RuntimeError)


if __name__ == '__main__':
    unittest.main()
