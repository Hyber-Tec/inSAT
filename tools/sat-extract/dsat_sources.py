"""Which files make up each DSAT practice test, in reading order.

The folders are not uniform: some tests are one scanned book, some split
Reading and Writing from Math, some are Word documents with a PDF export next to
them, one has only page JPEGs for its math book. This table is the single
place that decides what gets read for each test.

kinds:  book      the questions students see
        key       the answer key
        explain   answer explanations (usually repeats the key)
"""

TESTS = {
    1: {'book': ['Test 1/Digital_SAT_Test_1_student_book_new.pdf'],
        'key': ['Test 1/Digital_SAT_Test_1 answers_new.docx'],
        'format': '33/27', 'note': 'phone-screen layout, no explanations'},
    2: {'book': ['Test 2/Digital_SAT_Test_2_student_book_new.pdf'],
        'key': ['Test 2/Digital_SAT_Test_2_answers_new.pdf'],
        'explain': ['Test 2/Digital_SAT_Test_2_answer_explanations_new.pdf'], 'format': '33/27'},
    3: {'book': ['Test 3/Digital_SAT_Test_3_student_book_new.pdf'],
        'key': ['Test 3/Digital_SAT_Test_3_answers_new.pdf'],
        'explain': ['Test 3/Digital_SAT_Test_3_answer_explanations_new.pdf'], 'format': '33/27'},
    4: {'book': ['Test 4/Digital_SAT_Test_4_student_book_new.pdf'],
        'key': ['Test 4/Digital_SAT_Test_4_answers_new.pdf'],
        'explain': ['Test 4/Digital_SAT_Test_4_answer_explanations_new.pdf'], 'format': '33/27'},
    5: {'book': ['Test 5/Digital_SAT_Test_5_student_book_new.pdf'],
        'key': ['Test 5/Digital_SAT_Test_5_answers_new.pdf'],
        'explain': ['Test 5/Digital_SAT_Test_5_answer_explanations_new.pdf'], 'format': '33/27'},
    6: {'book': ['Test 6/Digital_SAT_Test_6_student_book_new.pdf'],
        'key': ['Test 6/Digital_SAT_Test_6_answers_new.pdf'],
        # The .docx is the same explanations as the PDF; the PDF is the scan we read.
        'explain': ['Test 6/Digital_SAT_Test_6_answer_explanations_new.pdf'], 'format': '33/27'},
    7: {'book': ['Test 7/Digital_SAT_Test_7_student_book.pdf'],
        'key': ['Test 7/Digital_SAT_Test_7_answers.pdf'],
        'explain': ['Test 7/Digital_SAT_Test_7_explanations_answers.pdf'], 'format': '27/22',
        'note': 'prep book; Module 2 marked "Harder"'},
    8: {'book': ['Test 8/Digital_SAT_Test_08_student_book (1).pdf'],
        'key': ['Test 8/Digital_SAT_Test_08_answers.pdf'],
        'explain': ['Test 8/Digital_SAT_Test_08_answer_explanations.pdf'], 'format': '27/22',
        'note': 'scan of a printed official College Board practice test'},
    9: {'book': ['Test 9/Digital_SAT_Test_009_student_book.pdf'],
        'key': ['Test 9/Digital_SAT_Test_009_answers.pdf'],
        'explain': ['Test 9/Digital_SAT_Test_009_answer_explanations.pdf'], 'format': '27/22',
        'note': 'scan of a printed official College Board practice test; some of its questions are also in '
                'Tests 11 and 12 or the question bank, and the import skips those as duplicates'},
    10: {'book': ['Test 10/sat-practice-test-10-digital.pdf'],
         'explain': ['Test 10/sat-practice-test-10-answers-digital.pdf'], 'format': '33/27',
         'note': 'College Board Practice Test #1, born-digital; the explanations carry the key; the linear (nondigital) edition, 33/27 per module'},
    11: {'book': ['Test 11/sat-practice-test-11-digital.pdf'],
         'explain': ['Test 11/sat-practice-test-11-answers-digital.pdf'], 'format': '33/27',
         'note': 'College Board Practice Test #2; the linear (nondigital) edition, 33/27 per module'},
    12: {'book': ['Test 12/sat-practice-test-12-digital.pdf'],
         'explain': ['Test 12/sat-practice-test-12-answers-digital.pdf'], 'format': '33/27',
         'note': 'College Board Practice Test #3; the linear (nondigital) edition, 33/27 per module'},
    13: {'book': ['Test 13/sat-practice-test-13-digital.pdf'],
         'explain': ['Test 13/sat-practice-test-13-answers-digital.pdf'], 'format': '33/27',
         'note': 'College Board Practice Test #4; the linear (nondigital) edition, 33/27 per module'},
    14: {'book': ['Test 14/Digital_SAT_Test_14_RnW_student_book.pdf', 'Test 14/Digital_SAT_Test_14_MATH_student_book.pdf'],
         'key': ['Test 14/Digital_SAT_Test_14_RnW_answers.docx', 'Test 14/Digital_SAT_Test_14_Math_answers.docx'],
         'explain': ['Test 14/Digital_SAT_Test_14_RnW_answer_explanations.docx',
                     'Test 14/Digital_SAT_Test_14_MATH_answer_explanations.docx'],
         'format': '33/27', 'note': 'Word conversion; modules not marked'},
    15: {'book': ['Test 15/Digital_SAT_Test_15_RnW_student_book.pdf', 'Test 15/Digital_SAT_Test_15_MATH_student_book'],
         'key': ['Test 15/Digital_SAT_Test_15_RnW_answers.docx', 'Test 15/Digital_SAT_Test_15_Math_answers.docx'],
         'explain': ['Test 15/Digital_SAT_Test_15_RnW_answer_explanations.docx',
                     'Test 15/Digital_SAT_Test_15_MATH_answer_explanations.docx'],
         'format': '33/27', 'note': 'Word conversion; the math book exists only as page JPEGs'},
    16: {'book': ['Test 16/Digital_SAT_Test_16_RnW_student_book_수정본.pdf', 'Test 16/Digital_SAT_Test_16_MATH_student_book_수정본.pdf'],
         'key': ['Test 16/Digital_SAT_Test_16_RnW_answers.docx', 'Test 16/Digital_SAT_Test_16_Math_answers.docx'],
         'explain': ['Test 16/Digital_SAT_Test_16_RnW_answer_explanations_수정본.docx',
                     'Test 16/Digital_SAT_Test_16_MATH_answer_explanations_수정본.docx'],
         'format': '33/27', 'note': 'Word conversion (revised edition); modules not marked'},
    17: {'book': ['Test 17/Digital_SAT_Test_017_student_book.pdf'],
         'key': ['Test 17/Digital_SAT_Test_017_answers.pdf'], 'format': '27/22',
         'note': 'scan of a printed official College Board practice test, no explanations'},
    18: {'book': ['Test 18/Digital_SAT_Test_18_student_book.pdf'],
         'key': ['Test 18/Digital_SAT_Test_18_answers.docx'], 'format': '27/22', 'note': 'no explanations'},
    19: {'book': ['Test 19/Digital_SAT_Test_19_student_book.pdf'],
         'key': ['Test 19/Digital_SAT_Test_19_answers.docx'], 'format': '27/22', 'note': 'no explanations'},
    20: {'book': ['Test 20/Digital_SAT_Test_20_student_book.pdf'],
         'key': ['Test 20/Digital_SAT_Test_20_answers.docx'], 'format': '27/22',
         'note': 'no explanations; the key\'s Reading and Writing Module 2 column is for a different form '
                 '(21 of 27 answers disagree with this book, while Module 1 and Math agree), so those '
                 'questions are settled by adjudication'},
    21: {'book': ['Test 21/Digital_SAT_Test_21_student_book.pdf'],
         'key': ['Test 21/Digital_SAT_Test_21_answers.pdf'],
         'explain': ['Test 21/Digital_SAT_Test_21_explanations_answers.pdf'], 'format': '27/22'},
    22: {'book': ['Test 22/Digital_SAT_Test_22_student_book.pdf'],
         'key': ['Test 22/Digital_SAT_Test_22_answers.pdf'],
         'explain': ['Test 22/Digital_SAT_Test_22_explanations_answers.pdf'], 'format': '27/22'},
    23: {'book': ['Test 23/Digital_SAT_Test_23_student_book.pdf'],
         'key': ['Test 23/Digital_SAT_Test_23_answers.pdf'],
         'explain': ['Test 23/Digital_SAT_Test_23_explanations_answers.pdf'], 'format': '27/22'},
}


def files(kind):
    """(test number, relative path) for every file of one kind, tests in order."""
    for t in sorted(TESTS):
        for rel in TESTS[t].get(kind, []):
            yield t, rel
