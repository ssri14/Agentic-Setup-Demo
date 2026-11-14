"""Static checks on analysis code before it runs. A teaching-demo guard, layered with
process isolation (no network, non-root, resource limits); not a security boundary on its own."""
import ast

ALLOWED_IMPORTS = {'pandas', 'numpy', 'math', 'statistics', 'json', 'csv', 'datetime', 'collections',
                   'itertools', 'functools', 're', 'matplotlib', 'matplotlib.pyplot', 'textwrap', 'decimal', 'fractions'}
BLOCKED_NAMES = {'open', 'exec', 'eval', 'compile', '__import__', 'globals', 'locals', 'vars', 'input',
                 'breakpoint', 'help', 'exit', 'quit', 'memoryview', 'getattr', 'setattr', 'delattr'}
BLOCKED_ATTRIBUTES = {'read_pickle', 'to_pickle', 'read_sql', 'to_sql', 'read_html', 'read_xml', 'to_parquet',
                      'read_parquet', 'read_feather', 'to_feather', 'to_hdf', 'read_hdf', 'to_csv', 'to_excel',
                      'read_csv', 'read_excel', 'read_json', 'to_json', 'savefig', 'tofile', 'fromfile', 'load', 'save',
                      'system', 'popen', 'spawn'}
MAX_CODE = 20_000


class PolicyError(ValueError):
    pass


def check(code: str) -> None:
    if len(code) > MAX_CODE:
        raise PolicyError(f'Code is longer than {MAX_CODE} characters')
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise PolicyError(f'Syntax error on line {exc.lineno}: {exc.msg}') from None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_IMPORTS:
                    raise PolicyError(f'Import of {alias.name!r} is not allowed (allowed: {", ".join(sorted(ALLOWED_IMPORTS))})')
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or '') not in ALLOWED_IMPORTS:
                raise PolicyError(f'Import from {node.module!r} is not allowed')
        elif isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            raise PolicyError(f'Use of {node.id!r} is not allowed; use load_input(name), show_table(df, name) and show_chart(fig, name)')
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith('__'):
                raise PolicyError('Access to double-underscore attributes is not allowed')
            if node.attr in BLOCKED_ATTRIBUTES:
                raise PolicyError(f'.{node.attr}() is not allowed; inputs come from load_input(name) and results go through show_table/show_chart')
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            raise PolicyError('global/nonlocal statements are not allowed')
