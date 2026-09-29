import os

lib_path = 'payment_router/src/lib.rs'
test_path = 'payment_router/src/test.rs'

with open(lib_path, 'r') as f:
    lines = f.readlines()

test_start = -1
for i, line in enumerate(lines):
    if line.strip() == '#[cfg(test)]' and lines[i+1].startswith('mod test {'):
        test_start = i
        break

if test_start != -1:
    test_lines = lines[test_start+2 : -1] # extract inside mod test { ... }
    # wait, we need to extract everything inside mod test { }
    # actually, I can just grab from test_start+2 to the end and remove the last '}'
    test_content = "".join(test_lines[:-1]) # omit the last '}'
    
    with open(test_path, 'w') as f:
        f.write(test_content)
    
    lib_content = "".join(lines[:test_start]) + "#[cfg(test)]\nmod test;\n"
    with open(lib_path, 'w') as f:
        f.write(lib_content)
    
    print("Extracted test mod to test.rs")
else:
    print("Could not find test mod")
