#!/usr/bin/env python3
import os
import re
import subprocess
import argparse
import sys

def build_with_esbuild(template_path, out_path):
    unpacked_dir = os.path.dirname(os.path.abspath(template_path))
    with open(template_path, 'r', encoding='utf-8') as f:
        html = f.read()

    print("🚀 Packing with esbuild...")

    # 1. Bundle CSS
    def replace_css(match):
        indent = match.group(1)
        id_attr = f' id="{match.group(2)}"' if match.group(2) else ''
        href = match.group(3)
        css_path = os.path.join(unpacked_dir, href)
        print(f"  [CSS] Bundling {href}")
        
        try:
            result = subprocess.run(
                ['esbuild', css_path, '--bundle', '--minify'],
                capture_output=True, text=True, check=True
            )
            css_content = result.stdout.strip()
            return f'{indent}<style{id_attr}>\n{indent}{css_content}\n{indent}</style>\n'
        except subprocess.CalledProcessError as e:
            print(f"❌ ESBuild Error (CSS):\n{e.stderr}")
            sys.exit(1)

    html = re.sub(
        r'^([ \t]*)<link(?: id="([^"]+)")?\s+rel="stylesheet"\s+href="\./([^"]+)">[ \t]*\n?',
        replace_css,
        html,
        flags=re.MULTILINE
    )

    # 2. Bundle JS Modules
    js_modules = []
    def collect_js(match):
        src = match.group(3)
        js_modules.append(src)
        return "" # remove the original tag from HTML

    html = re.sub(
        r'^([ \t]*)<script type="module"(?: id="([^"]+)")? src="\./([^"]+)"></script>[ \t]*\n?',
        collect_js,
        html,
        flags=re.MULTILINE
    )

    if js_modules:
        print(f"  [JS] Bundling {len(js_modules)} entry points into a single payload...")
        # Create a dynamic entry point importing all JS sequentially
        import_statements = "\n".join([f'import "./{src.replace(chr(92), "/")}";' for src in js_modules])
        entry_file = os.path.join(unpacked_dir, '_temp_entry.js')
        
        with open(entry_file, 'w', encoding='utf-8') as ef:
            ef.write(import_statements)
            
        try:
            result = subprocess.run(
                ['esbuild', '_temp_entry.js', '--bundle', '--minify', '--format=esm', '--target=es2020'],
                cwd=unpacked_dir, 
                capture_output=True, 
                text=True,
                check=True
            )
            bundled_js = result.stdout.strip()
            # Insert the bundled JS right before </body> to ensure synchronous order and clean DOM parsing
            bundle_tag = f'<script type="module">\n{bundled_js}\n</script>\n</body>'
            html = html.replace('</body>', bundle_tag)
        except subprocess.CalledProcessError as e:
            print(f"❌ ESBuild Error (JS):\n{e.stderr}")
            sys.exit(1)
        except FileNotFoundError:
            print("❌ ESBuild not found. Please ensure it is installed and in your PATH.")
            sys.exit(1)
        finally:
            if os.path.exists(entry_file):
                os.remove(entry_file)

    # 3. Inline Built-in Tools
    def replace_tools(match):
        indent = match.group(1)
        attrs = match.group(2)
        src = match.group(3)
        tool_path = os.path.join(unpacked_dir, src)
        print(f"  [TOOL] Inlining {src}")
        with open(tool_path, 'r', encoding='utf-8') as tf:
            content = tf.read().strip()
        # Ensure we don't accidentally close the script block early
        content = content.replace('</script>', '<\\/script>')
        return f'{indent}<script{attrs}>\n{content}\n{indent}</script>\n'

    html = re.sub(
        r'^([ \t]*)<script( type="text/plain"[^>]*) src="\./([^"]+)"></script>[ \t]*\n?',
        replace_tools,
        html,
        flags=re.MULTILINE
    )

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"✅ Successfully packed to {out_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Pack monolithic HTML application using esbuild.")
    parser.add_argument('--template', default='unpacked/index.template.html', help='Path to index.template.html')
    parser.add_argument('--out', default='index.html', help='Output HTML file path')
    args = parser.parse_args()
    build_with_esbuild(args.template, args.out)