<%- include('partials/head', {
  title: 'Advisor Approvals',
  heading: 'Advisor Approvals',
  subtitle: 'Review and approve student course registrations.'
}) %>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
  .advisor-wrapper { font-family: 'Plus Jakarta Sans', sans-serif; background: #fff; border-radius: 2rem; box-shadow: 0 30px 60px -20px rgba(10, 30, 50, 0.4); overflow: hidden; margin-bottom: 2rem; }
  .advisor-header { background: linear-gradient(105deg, #0a1e32 0%, #0f2a44 55%, #1e4d7b 100%); padding: 1.8rem 2.5rem; display: flex; align-items: center; justify-content: space-between; color: #fff; border-bottom: 4px solid #f5a623; }
  .student-card { padding: 1.5rem 2.5rem; border-bottom: 1px solid #d9e6f2; }
  .student-name { font-size: 1.25rem; font-weight: 800; color: #0a1e32; margin-bottom: 0.2rem; }
  .course-list-box { background: #f7fafd; border-radius: 1rem; padding: 1rem 1.5rem; margin-top: 1rem; border: 1px solid #d9e6f2; }
  .course-row { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px dashed #cbd5e1; }
  .course-row:last-child { border-bottom: none; }
  .btn-approve { background: #1f8a5f; color: #fff; border: none; padding: 0.7rem 1.5rem; border-radius: 10px; font-weight: 700; cursor: pointer; transition: 0.15s; }
  .btn-approve:hover { background: #166a48; transform: translateY(-1px); }
  .btn-reject { background: #b33e2e; color: #fff; border: none; padding: 0.7rem 1.5rem; border-radius: 10px; font-weight: 700; cursor: pointer; transition: 0.15s; }
  .btn-reject:hover { background: #922e20; transform: translateY(-1px); }
</style>

<div class="advisor-wrapper">
  <div class="advisor-header">
    <div>
      <h2 style="margin: 0; font-size: 1.5rem; font-weight: 800;"><i class="fas fa-clipboard-check" style="color: #ffc857;"></i> Pending Approvals</h2>
      <p style="margin: 0.2rem 0 0; color: #d9e6f2; font-size: 0.9rem;">Review student course selections below.</p>
    </div>
    <div style="background: rgba(255,255,255,0.1); padding: 0.5rem 1.5rem; border-radius: 100px;">
      <i class="fas fa-user-shield" style="color: #ffc857;"></i> Advisor Portal
    </div>
  </div>

  <% if (typeof pendingStudents === 'undefined' || pendingStudents.length === 0) { %>
    <div style="padding: 4rem 2rem; text-align: center; color: #64748b;">
      <i class="fas fa-check-circle" style="font-size: 4rem; color: #cbd5e1; margin-bottom: 1rem;"></i>
      <h3 style="font-size: 1.5rem; color: #0a1e32; margin-bottom: 0.5rem;">All caught up!</h3>
      <p>No pending registrations to approve right now.</p>
    </div>
  <% } else { %>
    <% pendingStudents.forEach(student => { %>
      <div class="student-card">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div class="student-name"><%= student.full_name || student.username %></div>
            <div style="color: #64748b; font-size: 0.9rem;"><%= student.total_courses %> courses requested</div>
          </div>
          
          <div style="display: flex; gap: 0.75rem;">
            <form method="POST" action="/sis/advisor/approvals/reject" style="margin: 0;">
              <input type="hidden" name="student_id" value="<%= student.id %>">
              <button type="submit" class="btn-reject" onclick="return confirm('Reject this registration?');"><i class="fas fa-times"></i> Reject</button>
            </form>
            <form method="POST" action="/sis/advisor/approvals/approve" style="margin: 0;">
              <input type="hidden" name="student_id" value="<%= student.id %>">
              <button type="submit" class="btn-approve"><i class="fas fa-check"></i> Approve</button>
            </form>
          </div>
        </div>

        <div class="course-list-box">
          <% pendingCourses.filter(c => c.student_id === student.id).forEach(course => { %>
            <div class="course-row">
              <span><strong style="color: #1e4d7b;"><%= course.code %></strong> - <span style="font-weight: 600; color: #0a1e32;"><%= course.title %></span></span>
              <span style="background: #e2e8f0; padding: 0.1rem 0.6rem; border-radius: 100px; font-size: 0.75rem; font-weight: 700;"><%= course.credits %> CR</span>
            </div>
          <% }) %>
        </div>
      </div>
    <% }) %>
  <% } %>
</div>

<%- include('partials/foot') %>